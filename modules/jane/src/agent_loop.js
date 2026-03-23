'use strict';
const ContextManager    = require('./context_manager');
const { buildSystemPrompt, buildChatPrompt, WORKSPACE } = require('./tool_registry');
const memory            = require('./memory_store');

const MAX_DEPTH = 12;

// ── Conversational intent detector ───────────────────────────────────
// Returns true if the message is pure chat — no tools needed.
// We skip the heavy agent loop for these and go direct to LLM.
const CHAT_PATTERNS = [
  /^(hi|hey|hello|howdy|yo|sup|greetings|good\s*(morning|evening|afternoon|night))\b/i,
  /^who\s+(are|r)\s+you\b/i,
  /^what\s+(are|r)\s+you\b/i,
  /^(what'?s?\s+your\s+name|your\s+name)\b/i,
  /^(how\s+are\s+you|how\s+r\s+u|how\s+do\s+u\s+do|how\s+you\s+doing)\b/i,
  /^(thanks|thank\s+you|ty|thx|tysm|cheers|ok|okay|cool|got\s+it|alright|nice|great|awesome|perfect|sounds\s+good)\b/i,
  /^(bye|goodbye|see\s+you|cya|later|take\s+care)\b/i,
  /^(yes|no|yeah|nah|yep|nope|sure|absolutely|definitely|of\s+course|not\s+really)\b/i,
  /^(tell\s+me\s+about\s+yourself|introduce\s+yourself)\b/i,
  /^what\s+can\s+you\s+do\b/i,
  /^(help|help\s+me)\s*\??$/i,
];

// Action words that definitely need the agent loop
const ACTION_WORDS = /\b(open|launch|run|execute|search|find|look\s+up|google|browse|create|write|make|build|install|download|delete|remove|move|copy|rename|list|show\s+me|read|fetch|get\s+me|play|start|stop|close|kill|restart)\b/i;

function isConversational(text) {
  const trimmed = text.trim();
  if (trimmed.length > 180) return false;      // long = likely complex task
  if (ACTION_WORDS.test(trimmed)) return false; // contains action verb
  if (trimmed.includes('<') || trimmed.includes('>')) return false;
  if (CHAT_PATTERNS.some(p => p.test(trimmed))) return true;
  // Short question/statement with no action verbs = probably chat
  if (trimmed.length < 60 && !ACTION_WORDS.test(trimmed)) return true;
  return false;
}

function extractToolCall(text) {
  const m = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (!m) return null;
  try   { return JSON.parse(m[1].trim()); }
  catch { return null; }
}

function stripToolCallBlock(text) {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

class JaneAgent {
  constructor(vre, model, personalization = {}) {
    this.vre     = vre;
    this.model   = model || 'auto';
    this.persona = personalization;

    const memBlock   = memory.getContextBlock();
    const sysPrompt  = buildSystemPrompt(personalization);
    const fullPrompt = sysPrompt + (memBlock ? '\n\n' + memBlock : '');
    this.context     = new ContextManager(fullPrompt);

    // Separate lightweight context for fast chat path (no tool defs)
    const chatPrompt  = buildChatPrompt(personalization);
    this.chatContext  = new ContextManager(chatPrompt + (memBlock ? '\n\n' + memBlock : ''));

    this._autoSwitched = false;
  }

  async run(userInput, { onStatus = () => {}, onEvent = () => {} } = {}) {
    // ── Extract special flags BEFORE they hit the LLM ────────────
    let cleanInput = userInput;
    let forceAgent = false;
    let imageB64   = null;   // extracted base64, never sent as text

    // Strip THINK_EXTENDED flag
    if (cleanInput.startsWith('[THINK_EXTENDED]')) {
      forceAgent  = true;
      cleanInput  = cleanInput.replace('[THINK_EXTENDED]', '').trim();
    }

    // Strip RECALL_CONTEXT block — context manager ALREADY has history,
    // injecting it again as text is what caused the 2M token overflow
    if (cleanInput.includes('[RECALL_CONTEXT]')) {
      // Just use forceAgent for a richer response — don't inject history text
      forceAgent = true;
      cleanInput = cleanInput.replace(/\[RECALL_CONTEXT\][\s\S]*?\[\/RECALL_CONTEXT\]/g, '').trim();
    }

    // Extract image base64 — NEVER send base64 as text to the LLM
    if (cleanInput.includes('[IMAGE_ATTACHED]')) {
      const m = cleanInput.match(/\[IMAGE_ATTACHED\]([\s\S]*?)\[\/IMAGE_ATTACHED\]/);
      if (m) {
        // Strip data URI prefix → raw base64
        imageB64 = m[1].replace(/^data:image\/[^;]+;base64,/, '').trim();
        cleanInput = cleanInput.replace(/\[IMAGE_ATTACHED\][\s\S]*?\[\/IMAGE_ATTACHED\]/, '').trim();
      }
    }

    // Image path: use inferWithImage directly
    if (imageB64) {
      return this._runVision(cleanInput || 'Describe this image in detail.', imageB64, { onStatus, onEvent });
    }

    // ── FAST PATH: pure conversation ──────────────────────────────
    if (!forceAgent && isConversational(cleanInput)) {
      return this._runChat(cleanInput, { onStatus, onEvent });
    }
    // ── AGENT LOOP PATH ───────────────────────────────────────────
    return this._runAgent(cleanInput, { onStatus, onEvent });
  }

  // Vision path — calls inferWithImage directly, proper multimodal
  async _runVision(prompt, imageB64, { onStatus, onEvent }) {
    onStatus('Analyzing image…');
    onEvent({ type: 'thinking', step: 1, max: 1 });
    this.context.addUser(prompt + ' [image attached]');
    try {
      const result = await this.vre.toolCall('llm.vision', {
        prompt,
        image_base64: imageB64,
        options: { max_tokens: 1000, temperature: 0.2 }
      });
      if (result.error) {
        onEvent({ type: 'error', message: `Vision error: ${result.error}` });
        return;
      }
      const text = result.content || '';
      this.context.addAssistant(text);
      onEvent({ type: 'response', text, model: result.model || 'llava' });
      return text;
    } catch(err) {
      onEvent({ type: 'error', message: err.message });
    }
  }


  // Direct chat — one LLM call, minimal prompt, fast, WITH streaming
  async _runChat(userInput, { onStatus, onEvent }) {
    onStatus('Thinking…');
    onEvent({ type: 'thinking', step: 1, max: 1 });

    this.chatContext.addUser(userInput);
    this.context.addUser(userInput);

    let llmResult;
    try {
      llmResult = await this.vre.toolCall('llm.infer', {
        messages: this.chatContext.getMessages(),
        model:    this.model,
        options:  {
          temperature: 0.75,
          max_tokens:  600,
          onChunk: chunk => onEvent({ type: 'chunk', text: chunk }),
        }
      });
    } catch (err) {
      return this._runAgent(userInput, { onStatus, onEvent }, true);
    }

    if (llmResult.error) {
      return this._runAgent(userInput, { onStatus, onEvent }, true);
    }

    const text = (llmResult.content || '').trim();
    if (extractToolCall(text)) {
      return this._runAgent(userInput, { onStatus, onEvent }, true);
    }

    this.chatContext.addAssistant(text);
    this.context.addAssistant(text);
    onEvent({ type: 'response', text, model: llmResult.selectedModel || this.model });
    this._extractMemoryAsync(text);
    return text;
  }

  // Full agent loop — for tool use, research, actions
  async _runAgent(userInput, { onStatus, onEvent }, alreadyAdded = false) {
    if (!alreadyAdded) {
      this.context.addUser(userInput);
      this.chatContext.addUser(userInput); // keep chat context in sync
    }

    let depth = 0;
    let lastResponse = '';
    let activeModel = this.model;

    while (depth < MAX_DEPTH) {
      depth++;
      onStatus(`Thinking (step ${depth}/${MAX_DEPTH})…`);
      onEvent({ type: 'thinking', step: depth, max: MAX_DEPTH });

      let llmResult;
      try {
        llmResult = await this.vre.toolCall('llm.infer', {
          messages: this.context.getMessages(),
          model:    activeModel,
          options:  { temperature: 0.72, max_tokens: 1800 }
        });
      } catch (err) {
        const msg = `LLM call failed: ${err.message}\nMake sure llama-server is running.`;
        onEvent({ type: 'error', message: msg });
        return msg;
      }

      if (llmResult.error) {
        const msg = `LLM error: ${llmResult.error}`;
        onEvent({ type: 'error', message: msg });
        return msg;
      }

      // Auto model switch on refusal
      if (llmResult.refusal_detected && llmResult.switch_to && !this._autoSwitched) {
        this._autoSwitched = true;
        activeModel = llmResult.switch_to;
        onEvent({ type: 'model_switched', from: this.model, to: activeModel, reason: 'refusal_detected' });
        onStatus(`Switching to ${activeModel}…`);
        depth--;
        continue;
      }

      if (llmResult.auto_selected && llmResult.selectedModel) {
        onEvent({ type: 'model_selected', model: llmResult.selectedModel });
      }

      const rawContent  = llmResult.content || '';
      const toolCall    = extractToolCall(rawContent);
      const displayText = stripToolCallBlock(rawContent);

      this.context.addAssistant(rawContent);

      if (!toolCall) {
        lastResponse = displayText || rawContent;
        this.chatContext.addAssistant(lastResponse); // sync chat context
        onEvent({ type: 'response', text: lastResponse, model: llmResult.selectedModel || activeModel });
        this._extractMemoryAsync(lastResponse);
        this._autoSwitched = false;
        return lastResponse;
      }

      const callId = `tc_${Date.now()}`;
      onStatus(`Running: ${toolCall.tool}`);
      onEvent({
        type:      'tool_call',
        callId,
        tool:      toolCall.tool,
        params:    toolCall.params || {},
        reasoning: displayText || '',
        step:      depth,
      });

      let toolResult;
      try {
        toolResult = await this.vre.toolCall(
          toolCall.tool,
          toolCall.params || {},
          { rationale: `Jane step ${depth}: ${displayText.slice(0, 100)}` }
        );
      } catch (err) {
        toolResult = { error: `Tool failed: ${err.message}` };
      }

      this.context.addToolResult(toolCall.tool, toolResult);
      onEvent({
        type:    'tool_result',
        callId,
        tool:    toolCall.tool,
        result:  toolResult,
        success: !toolResult.error,
      });
    }

    const forcedMsg = `Reached reasoning limit (${MAX_DEPTH} steps). Please break the task into smaller steps.`;
    this.context.addAssistant(forcedMsg);
    onEvent({ type: 'response', text: forcedMsg });
    return forcedMsg;
  }

  _extractMemoryAsync(response) {
    const msgs = this.context.getMessages();
    if (!msgs || msgs.length < 3) return;
    const inferFn = async (messages, model, opts) => {
      try { return await this.vre.toolCall('llm.infer', { messages, model, options: opts }); }
      catch { return { content: '' }; }
    };
    memory.extractAndStore(msgs, inferFn, this.model).catch(() => {});
  }

  reset() {
    this.context.clear();
    this.chatContext.clear();
    this._autoSwitched = false;
  }

  historySize() { return this.context.size(); }
  getModel()    { return this.model; }

  async generateTitle(messages) {
    if (!messages?.length) return 'New Conversation';
    const sample = messages.slice(0, 4)
      .map(m => `${m.role === 'user' ? 'User' : 'Jane'}: ${String(m.content || m.text || '').slice(0, 100)}`)
      .join('\n');
    try {
      const r = await this.vre.toolCall('llm.infer', {
        messages: [{ role: 'user', content: `Write a 3-5 word title for this conversation. No quotes:\n\n${sample}\n\nTitle:` }],
        model:   this.model,
        options: { temperature: 0.2, max_tokens: 14 }
      });
      return (r.content || '').trim().replace(/['".,!?:]/g, '').slice(0, 52) || 'Conversation';
    } catch {
      const first = messages.find(m => m.role === 'user');
      return String(first?.content || first?.text || 'Conversation').slice(0, 46);
    }
  }
}

module.exports = { JaneAgent, WORKSPACE };

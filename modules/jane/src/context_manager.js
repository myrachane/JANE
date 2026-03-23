'use strict';

const MAX_HISTORY     = 20;    // max messages to keep (reduced from 30)
const MAX_TOOL_OUTPUT = 4000;  // truncate large tool results
const MAX_MSG_CHARS   = 2000;  // truncate any single very long message
// Rough token estimate: 1 token ≈ 4 chars. Leave headroom for system prompt + response.
const MAX_CONTEXT_CHARS = 18000; // ~4500 tokens of history (for 8192 ctx)

class ContextManager {
  constructor(systemPrompt) {
    this.system   = systemPrompt;
    this.messages = [];
  }

  addUser(content) {
    // Truncate any single enormous message (e.g. user pasted 10k chars)
    const safe = String(content).slice(0, MAX_MSG_CHARS);
    this.messages.push({ role: 'user', content: safe });
    this._trim();
  }

  addAssistant(content) {
    const safe = String(content).slice(0, MAX_MSG_CHARS);
    this.messages.push({ role: 'assistant', content: safe });
    this._trim();
  }

  addToolResult(toolName, result) {
    const raw = typeof result === 'object'
      ? JSON.stringify(result, null, 2)
      : String(result);
    const truncated = raw.length > MAX_TOOL_OUTPUT
      ? raw.slice(0, MAX_TOOL_OUTPUT) + `\n\n... [output truncated at ${MAX_TOOL_OUTPUT} chars]`
      : raw;
    this.messages.push({
      role:    'user',
      content: `[Tool result: ${toolName}]\n${truncated}`
    });
    this._trim();
  }

  getMessages() {
    return [
      { role: 'system', content: this.system },
      ...this.messages
    ];
  }

  _trim() {
    // Hard count trim
    if (this.messages.length > MAX_HISTORY) {
      this.messages = this.messages.slice(-MAX_HISTORY);
    }
    // Token-aware trim: if total chars exceed limit, drop oldest pairs
    let totalChars = this.system.length;
    for (const m of this.messages) totalChars += m.content.length;
    while (totalChars > MAX_CONTEXT_CHARS && this.messages.length > 2) {
      const removed = this.messages.shift();
      totalChars -= removed.content.length;
    }
  }

  clear() {
    this.messages = [];
  }

  size() { return this.messages.length; }
}

module.exports = ContextManager;

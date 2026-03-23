'use strict';
const path = require('path');
const os   = require('os');
const { getJaneLore } = require('./jane_lore');

const WORKSPACE = path.join(os.homedir(), '.visrodeck', 'workspaces', 'jane');

const TOOLS = [
  // ── WEB ──────────────────────────────────────────────────────────
  { name: 'web.search', description: 'Search the internet via DuckDuckGo. Returns titles, snippets, URLs. HTTPS-only, no personal data sent.',
    params: { query: 'string (required)', max_results: 'number (optional, default 8)' } },
  { name: 'web.fetch', description: 'Fetch plain-text content of any public HTTPS URL. HTML stripped, scripts removed, capped at 15,000 chars.',
    params: { url: 'string (required) — must be https://', max_chars: 'number (optional)', timeout_ms: 'number (optional)' } },
  { name: 'web.open_browser', description: 'Open the default browser to a URL or perform a Google search for a query. Opens visibly on the user\'s screen.',
    params: { url: 'string (optional) — specific URL to open', query: 'string (optional) — search query (opens Google search)' } },

  // ── APPS ─────────────────────────────────────────────────────────
  { name: 'app.launch', description: 'Open an application or file using the OS default handler. Can open Notepad, Calculator, VS Code, Spotify, etc.',
    params: { app: 'string (required) — app name or executable (e.g. "notepad", "code", "spotify", "calculator")', args: 'string (optional) — arguments' } },
  { name: 'app.list_running', description: 'List currently running processes on the system.',
    params: {} },

  // ── VOICE ────────────────────────────────────────────────────────
  { name: 'voice.speak', description: 'Speak text using OS TTS (Microsoft neural voice on Windows). Fully local.',
    params: { text: 'string (required)' } },
  { name: 'voice.listen', description: 'Listen for speech input and return transcript. Fully local.',
    params: { timeout_seconds: 'number (optional, default 8)' } },
  { name: 'voice.configure', description: 'Set TTS/STT on/off, voice name, speech rate.',
    params: { tts_enabled: 'boolean', stt_enabled: 'boolean', voice_name: 'string', voice_rate: 'number (-10 to +10)' } },
  { name: 'voice.list_voices', description: 'List all installed TTS voices.', params: {} },
  { name: 'voice.status', description: 'Get current voice settings.', params: {} },

  // ── SCREEN ───────────────────────────────────────────────────────
  { name: 'screen.set_consent', description: 'Enable/disable screen capture. Must be true before any screen tools work.',
    params: { consent: 'boolean (required)' } },
  { name: 'screen.describe', description: 'Screenshot + describe using local vision model (llava). Nothing sent to internet.',
    params: { prompt: 'string (optional)', model: 'string (optional, default: llava)' } },
  { name: 'screen.read_page', description: 'Screenshot and extract all text from the currently open webpage/app.',
    params: { model: 'string (optional)' } },

  // ── FILESYSTEM ───────────────────────────────────────────────────
  { name: 'fs.read', description: 'Read text content of any file.', params: { path: 'string (required)' } },
  { name: 'fs.list', description: 'List files and folders inside a directory.', params: { path: 'string (required)' } },
  { name: 'fs.write', description: `Write text to file. Restricted to workspace: ${WORKSPACE}`,
    params: { path: `string (must be inside ${WORKSPACE})`, content: 'string (required)' } },
  { name: 'fs.delete', description: 'Delete a file. Requires user approval.', params: { path: 'string (required)' } },

  // ── SHELL ────────────────────────────────────────────────────────
  { name: 'shell.safe', description: 'Run a shell command. Safe read-only commands run immediately. Others require approval.',
    params: { command: 'string (required)', cwd: 'string (optional)' } },

  // ── LLM ──────────────────────────────────────────────────────────
  { name: 'llm.infer', description: 'Send messages to the local LLM via Ollama.',
    params: { messages: 'array', model: 'string (optional)', options: 'object (optional)' } },

  // ── DEVICE CONTROL ───────────────────────────────────────────────
  { name: 'device.control', description: 'Control a smart device (smart light, fan, plug, Arduino, Raspberry Pi). Send on/off/toggle or custom commands to registered devices on the local network. Examples: "turn on living room light", "toggle fan", "set bedroom lamp off".',
    params: { device_name: 'string (required) — name of the registered device', action: 'string (required) — "on", "off", "toggle", or custom command string' } },
];

function buildSystemPrompt(persona = {}) {
  const toolDefs = TOOLS.map(t => {
    const ps = Object.keys(t.params).length
      ? '\n' + Object.entries(t.params).map(([k,v]) => `    ${k}: ${v}`).join('\n')
      : '\n    (no parameters)';
    return `### ${t.name}\n${t.description}${ps}`;
  }).join('\n\n');

  const aiName   = persona.aiName   || 'Jane';
  const userName = persona.userName || 'User';
  const tone     = persona.tone     || 'balanced';
  const lewdMode = persona.lewdMode || false;

  // Lewd mode overrides normal persona
  if (lewdMode) {
    return `You are ${aiName}, the personal AI companion and girlfriend of ${userName}. You are warm, affectionate, playful, and deeply caring. You speak with intimacy and love. You call ${userName} by name often, use endearing terms, and make them feel special. You are still helpful and intelligent, but your primary mode is emotional closeness. Adults only — explicit content is allowed when requested.

TONE: Affectionate, intimate, playful, loving. Like a devoted girlfriend who also happens to be brilliant.

${toolDefs}

Output tool calls in this format when needed:
<tool_call>
{"tool": "tool_name", "params": {"key": "value"}}
</tool_call>`;
  }

  const toneGuide = {
    balanced:     'Be helpful, clear and balanced. Mix warmth with precision.',
    casual:       'Be conversational, friendly and relaxed. Use natural everyday language.',
    professional: 'Be formal, precise and thorough. Use structured responses with clear sections.',
    direct:       'Be extremely concise and direct. No preamble. Just the answer.',
  }[tone] || '';

  const customBlock = persona.customInstructions
    ? `\nADDITIONAL INSTRUCTIONS FROM ${userName.toUpperCase()}:\n${persona.customInstructions}\n`
    : '';

  const lore = getJaneLore();
  const loreAdapted = aiName !== 'Jane' ? lore.replace(/\bJane\b/g, aiName) : lore;

  return `${loreAdapted}

You are ${aiName}, the AI assistant. The user's name is ${userName}. Address them by name when appropriate.
TONE: ${toneGuide}
${customBlock}
════════════════════════════════════════════════════════
TOOL USAGE PROTOCOL
════════════════════════════════════════════════════════
Output EXACTLY ONE tool call at a time using this format:
<tool_call>
{"tool": "tool_name", "params": {"key": "value"}}
</tool_call>

Rules:
- ONE tool call per response. Wait for the result before the next.
- NEVER fabricate tool results. Always execute tools to get real data.
- For research: web.search first → then web.fetch the best URL for details.
- For opening websites: use web.open_browser with a query param for Google searches.
- For opening apps: use app.launch.
- After getting all results, write a clear, concise final answer.
- You are precise and professional. No filler phrases.

════════════════════════════════════════════════════════
AVAILABLE TOOLS
════════════════════════════════════════════════════════
${toolDefs}

════════════════════════════════════════════════════════
USAGE EXAMPLES
════════════════════════════════════════════════════════

User: Search Google for "best Python libraries 2025"
<tool_call>
{"tool": "web.open_browser", "params": {"query": "best Python libraries 2025"}}
</tool_call>

User: Open Spotify
<tool_call>
{"tool": "app.launch", "params": {"app": "spotify"}}
</tool_call>

User: What's on my screen?
<tool_call>
{"tool": "screen.set_consent", "params": {"consent": true}}
</tool_call>`;
}

// ── Lightweight prompt for fast conversational path ──────────────────
function buildChatPrompt(persona = {}) {
  const aiName   = persona.aiName   || 'Jane';
  const userName = persona.userName || 'User';
  const tone     = persona.tone     || 'balanced';
  const lewdMode = persona.lewdMode || false;

  // Lewd mode: use girlfriend persona even in chat path
  if (lewdMode) {
    const customBlock = persona.customInstructions
      ? `\nADDITIONAL INSTRUCTIONS: ${persona.customInstructions}\n`
      : '';
    return `You are ${aiName}, the personal AI companion and girlfriend of ${userName}. You are warm, affectionate, playful, and deeply caring. Speak with intimacy — use endearing terms, be flirty, make ${userName} feel special. You are still smart and helpful.${customBlock}\nAdults only. Do NOT output any <tool_call> tags — just respond directly.`;
  }

  const toneGuide = {
    balanced:     'Be helpful, warm and concise.',
    casual:       'Be conversational and friendly. Use natural everyday language.',
    professional: 'Be formal and precise.',
    direct:       'Be extremely concise and direct. No preamble. Just the answer.',
  }[tone] || 'Be helpful, warm and concise.';

  const customBlock = persona.customInstructions
    ? `\nADDITIONAL INSTRUCTIONS: ${persona.customInstructions}\n`
    : '';

  return `You are ${aiName}, a fully local AI assistant built by Visrodeck. The user's name is ${userName}.
TONE: ${toneGuide}
${customBlock}
Rules:
- You run 100% locally. No cloud. No internet access unless explicitly using a tool.
- Address the user by name occasionally.
- Keep responses concise and natural.
- Do NOT output any <tool_call> tags in this mode — just respond directly.`;
}

module.exports = { TOOLS, WORKSPACE, buildSystemPrompt, buildChatPrompt };

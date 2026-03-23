'use strict';
const { exec }     = require('child_process');
const util         = require('util');
const execAsync    = util.promisify(exec);
const { v4: uuid } = require('uuid');

const fsCtrl    = require('../fs_controller');
const llmOrch   = require('../llm_orchestrator');
const permEng   = require('../permission_engine');
const launcher  = require('../app_launcher');
const urlGuard  = require('../url_guard');
const voice     = require('../voice');
const screen    = require('../screen');
const eventBus  = require('../../kernel/event_bus');
const audit     = require('../../audit/logger');

// ── Constants ────────────────────────────────────────────────────────
const APPROVAL_TIMEOUT = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;      // 1 MB hard cap on fetched content
const MAX_RESPONSE_CHARS = 15_000;           // char cap returned to LLM

const USER_AGENT = 'VRE-Jane/0.1 (local-only; no-tracking)';

// ── Approval queue ───────────────────────────────────────────────────
const approvalQueue = new Map();

// ── Safe shell allowlist ─────────────────────────────────────────────
const SAFE_PATTERNS = [
  /^ls(\s|$)/i, /^dir(\s|$)/i, /^pwd$/i,
  /^echo\s/, /^cat\s/, /^head(\s|$)/, /^tail(\s|$)/,
  /^grep(\s|$)/, /^find\s/, /^wc(\s|$)/,
  /^which\s/, /^type\s/, /^where\s/,
  /^git\s(status|log|diff|show|branch|remote\s-v)/,
  /^node\s(-v|--version)$/i, /^npm\s(-v|--version|list|ls)$/i,
  /^python\s(--version|-V)$/i, /^pip\s(list|show|freeze)/i,
  /^uname(\s|$)/, /^hostname$/i, /^whoami$/i, /^date$/i,
];
function isSafeShell(cmd) {
  return SAFE_PATTERNS.some(p => p.test(cmd.trim()));
}

// ── HTML → Plain text ────────────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\t/g, ' ')
    .replace(/[ ]{3,}/g, '  ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

// ── Secure fetch ─────────────────────────────────────────────────────
async function secureFetch(rawUrl, options = {}) {
  // 1. URL guard (async — does DNS check)
  const guard = await urlGuard.guard(rawUrl);
  if (!guard.ok) return { error: `[URL Blocked] ${guard.reason}` };

  const controller = new AbortController();
  const timeout    = Math.min(options.timeout_ms || 15000, 30000);
  const timer      = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(guard.url.toString(), {
      signal:  controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept':     'text/html,application/json,text/plain,*/*',
        // Do NOT send cookies, credentials, or referrer
        'Cookie':     '',
        'Referer':    '',
      },
      credentials: 'omit',
      redirect:    'follow',
    });
    clearTimeout(timer);

    // 2. Content-length check BEFORE reading body
    const lengthHeader = res.headers.get('content-length');
    if (lengthHeader && parseInt(lengthHeader) > MAX_RESPONSE_BYTES) {
      return { error: `Response too large (${lengthHeader} bytes). Limit is ${MAX_RESPONSE_BYTES} bytes.` };
    }

    // 3. Read with byte cap
    const reader  = res.body.getReader();
    const chunks  = [];
    let   total   = 0;
    let   capped  = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_RESPONSE_BYTES) {
        chunks.push(value.slice(0, MAX_RESPONSE_BYTES - (total - value.length)));
        capped = true;
        break;
      }
      chunks.push(value);
    }

    // 4. Decode
    const raw         = Buffer.concat(chunks).toString('utf8');
    const contentType = res.headers.get('content-type') || '';

    // 5. Convert to plain text only — ALWAYS. No HTML or scripts ever returned.
    let text;
    if (contentType.includes('application/json')) {
      try { text = JSON.stringify(JSON.parse(raw), null, 2); }
      catch { text = raw; }
    } else if (contentType.includes('text/html') || contentType.includes('text/xml')) {
      text = htmlToText(raw);
    } else {
      // text/plain, application/xml, etc. — strip any embedded scripts anyway
      text = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
    }

    // 6. Char cap
    const maxChars = Math.min(options.max_chars || MAX_RESPONSE_CHARS, MAX_RESPONSE_CHARS);
    let   truncated = false;
    if (text.length > maxChars) {
      text      = text.slice(0, maxChars);
      truncated = true;
    }

    return {
      url:          guard.url.toString(),
      status:       res.status,
      content_type: contentType,
      content:      text,
      truncated,
      size_bytes:   total,
      capped_at_bytes: capped ? MAX_RESPONSE_BYTES : undefined,
    };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { error: `Request timed out after ${timeout}ms` };
    return { error: `Fetch failed: ${err.message}` };
  }
}

// ── DuckDuckGo search ────────────────────────────────────────────────
async function duckduckgoSearch(query, maxResults = 8) {
  // Build the API URL using our guard
  const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

  const result = await secureFetch(apiUrl, { max_chars: 50000 });
  if (result.error) return result;

  let data;
  try { data = JSON.parse(result.content); }
  catch { return { error: 'DuckDuckGo returned invalid JSON', raw: result.content.slice(0, 200) }; }

  const results = [];

  if (data.AbstractText) {
    results.push({
      title:   data.Heading || query,
      url:     data.AbstractURL || '',
      snippet: data.AbstractText,
      source:  data.AbstractSource || 'DuckDuckGo',
    });
  }

  if (data.Answer) {
    results.push({ title: 'Direct Answer', url: '', snippet: data.Answer, source: 'DuckDuckGo' });
  }

  for (const topic of (data.RelatedTopics || [])) {
    if (results.length >= maxResults) break;
    const topics = topic.Topics || [topic];
    for (const t of topics) {
      if (results.length >= maxResults) break;
      if (t.Text && t.FirstURL) {
        results.push({ title: t.Text.slice(0, 100), url: t.FirstURL, snippet: t.Text, source: 'DuckDuckGo' });
      }
    }
  }

  return {
    query,
    engine:  'DuckDuckGo',
    results,
    note: results.length === 0
      ? 'No instant results found. Try web.fetch on a specific URL, or rephrase the query.'
      : undefined,
  };
}

// ── Main execute ─────────────────────────────────────────────────────
async function execute(moduleId, toolCall) {
  const { tool, params = {}, call_id, rationale = '' } = toolCall;
  const callId = call_id || uuid();
  eventBus.publish('tool.started', { moduleId, tool, callId });
  let result;
  try   { result = await _dispatch(moduleId, tool, params, rationale, callId); }
  catch (err) { result = { error: err.message }; }
  eventBus.publish(result.error ? 'tool.failed' : 'tool.completed', { moduleId, tool, callId, success: !result.error });
  return result;
}

async function _dispatch(moduleId, tool, params, rationale, callId) {
  switch (tool) {

    // ── WEB SEARCH ───────────────────────────────────────────────────
    case 'web.search': {
      const p = permEng.check(moduleId, 'web.search', params.query);
      if (!p.allowed) return { error: p.reason };
      if (!params.query?.trim()) return { error: 'params.query is required' };
      return duckduckgoSearch(params.query.trim(), params.max_results || 8);
    }

    // ── WEB FETCH ────────────────────────────────────────────────────
    case 'web.fetch': {
      const p = permEng.check(moduleId, 'web.fetch', params.url);
      if (!p.allowed) return { error: p.reason };
      if (!params.url) return { error: 'params.url is required' };
      return secureFetch(params.url, {
        timeout_ms: params.timeout_ms,
        max_chars:  params.max_chars,
      });
    }

    // ── WEB OPEN BROWSER ────────────────────────────────────────────
    case 'web.open_browser': {
      const p = permEng.check(moduleId, 'shell.safe', null);
      if (!p.allowed) return { error: p.reason };
      let target;
      if (params.url) {
        const g = urlGuard.guardSync(params.url);
        if (!g.ok) return { error: g.reason };
        target = params.url;
      } else if (params.query) {
        target = `https://www.google.com/search?q=${encodeURIComponent(params.query)}`;
      } else {
        return { error: 'Provide url or query.' };
      }
      const opener = process.platform === 'win32'  ? `start "" "${target}"`
                   : process.platform === 'darwin' ? `open "${target}"`
                   : `xdg-open "${target}"`;
      try {
        await execAsync(opener, { shell: true });
        return { opened: true, url: target };
      } catch (e) { return { error: e.message }; }
    }

    // ── APP LAUNCH ───────────────────────────────────────────────────
    case 'app.launch': {
      const p = permEng.check(moduleId, 'shell.safe', params.app);
      if (!p.allowed) return { error: p.reason };
      const app  = (params.app || '').trim();
      const args = (params.args || '').trim();
      if (!app) return { error: 'params.app is required' };
      let cmd;
      if (process.platform === 'win32') {
        // Windows: try start first (works for most apps by name)
        const knownApps = {
          notepad: 'notepad.exe', calculator: 'calc.exe', paint: 'mspaint.exe',
          explorer: 'explorer.exe', cmd: 'cmd.exe', powershell: 'powershell.exe',
          wordpad: 'wordpad.exe', taskmgr: 'taskmgr.exe',
        };
        const exe = knownApps[app.toLowerCase()] || app;
        cmd = args ? `start "" "${exe}" ${args}` : `start "" "${exe}"`;
      } else if (process.platform === 'darwin') {
        cmd = args ? `open -a "${app}" --args ${args}` : `open -a "${app}"`;
      } else {
        cmd = args ? `${app} ${args} &` : `${app} &`;
      }
      try {
        await execAsync(cmd, { shell: true, timeout: 8000 });
        return { launched: true, app, args };
      } catch (e) { return { error: `Could not launch '${app}': ${e.message}` }; }
    }

    // ── APP LIST RUNNING ─────────────────────────────────────────────
    case 'app.list_running': {
      const p = permEng.check(moduleId, 'shell.safe', null);
      if (!p.allowed) return { error: p.reason };
      const cmd = process.platform === 'win32'
        ? 'tasklist /fo csv /nh'
        : process.platform === 'darwin'
          ? 'ps -ax -o pid,comm | head -40'
          : 'ps -ax -o pid,comm --no-headers | head -40';
      try {
        const { stdout } = await execAsync(cmd, { shell: true, timeout: 10000 });
        return { processes: stdout.trim().split('\n').slice(0, 40) };
      } catch (e) { return { error: e.message }; }
    }

    // ── VOICE SPEAK ──────────────────────────────────────────────────
    case 'voice.speak': {
      const p = permEng.check(moduleId, 'voice.speak', null);
      if (!p.allowed) return { error: p.reason };
      if (!params.text) return { error: 'params.text is required' };
      return voice.speak(params.text);
    }

    // ── VOICE LISTEN ─────────────────────────────────────────────────
    case 'voice.listen': {
      const p = permEng.check(moduleId, 'voice.listen', null);
      if (!p.allowed) return { error: p.reason };
      return voice.listen(params.timeout_seconds || 8);
    }

    // ── VOICE STATUS / CONFIG ────────────────────────────────────────
    case 'voice.status':
      return voice.getStatus();

    case 'voice.list_voices':
      return { voices: await voice.listVoices() };

    case 'voice.configure': {
      const p = permEng.check(moduleId, 'voice.speak', null);
      if (!p.allowed) return { error: p.reason };
      voice.configure(params);
      return { ok: true, status: voice.getStatus() };
    }

    // ── SCREEN CAPTURE ───────────────────────────────────────────────
    case 'screen.capture': {
      const p = permEng.check(moduleId, 'screen.capture', null);
      if (!p.allowed) return { error: p.reason };
      if (!screen.hasConsent()) {
        return {
          error:   'Screen capture is not enabled.',
          action:  'Call screen.set_consent with consent=true to enable it.',
        };
      }
      return screen.capture({ window_only: params.window_only || false });
    }

    // ── SCREEN DESCRIBE (capture + vision model) ─────────────────────
    case 'screen.describe': {
      const p = permEng.check(moduleId, 'screen.capture', null);
      if (!p.allowed) return { error: p.reason };
      if (!screen.hasConsent()) {
        return {
          error:  'Screen capture is not enabled.',
          action: 'Call screen.set_consent with consent=true to enable it.',
        };
      }
      // Get Ollama config from llm orchestrator
      const cfg = require('../llm_orchestrator').getConfig();
      return screen.captureAndDescribe(
        params.prompt || 'Describe what is visible on the screen in detail.',
        cfg.ollama_url,
        params.model || cfg.vision_model || 'llava',
        { keep_file: false }
      );
    }

    // ── READ OPEN WEBPAGE ─────────────────────────────────────────────
    case 'screen.read_page': {
      const p = permEng.check(moduleId, 'screen.capture', null);
      if (!p.allowed) return { error: p.reason };
      if (!screen.hasConsent()) {
        return { error: 'Screen capture not enabled. Call screen.set_consent first.' };
      }
      const cfg = require('../llm_orchestrator').getConfig();
      return screen.readCurrentPage(cfg.ollama_url, params.model || cfg.vision_model || 'llava');
    }

    // ── SCREEN CONSENT ───────────────────────────────────────────────
    case 'screen.set_consent': {
      const p = permEng.check(moduleId, 'screen.capture', null);
      if (!p.allowed) return { error: p.reason };
      if (params.consent === true) {
        screen.grantConsent();
        return { ok: true, message: 'Screen capture enabled. Jane can now see your screen.' };
      } else {
        screen.revokeConsent();
        return { ok: true, message: 'Screen capture disabled.' };
      }
    }

    // ── FS READ ──────────────────────────────────────────────────────
    case 'fs.read': {
      const p = permEng.check(moduleId, 'fs.read', params.path);
      if (!p.allowed) return { error: p.reason };
      try { return { content: await fsCtrl.read(params.path), path: params.path }; }
      catch (e) { return { error: e.message }; }
    }

    case 'fs.list': {
      const p = permEng.check(moduleId, 'fs.list', params.path);
      if (!p.allowed) return { error: p.reason };
      try { return { entries: await fsCtrl.list(params.path), path: params.path }; }
      catch (e) { return { error: e.message }; }
    }

    case 'fs.write': {
      const p = permEng.check(moduleId, 'fs.write', params.path);
      if (!p.allowed) return { error: p.reason };
      try { await fsCtrl.write(params.path, params.content || ''); return { success: true, path: params.path }; }
      catch (e) { return { error: e.message }; }
    }

    case 'fs.delete': {
      const p = permEng.check(moduleId, 'fs.delete', params.path);
      if (p.needsApproval) {
        const ok = await _requestApproval(moduleId, { tool, params, rationale });
        if (!ok) return { error: 'User denied approval for fs.delete' };
        const p2 = permEng.check(moduleId, 'fs.delete', params.path, { approved: true });
        if (!p2.allowed) return { error: p2.reason };
      } else if (!p.allowed) return { error: p.reason };
      try { await fsCtrl.remove(params.path); return { success: true, path: params.path }; }
      catch (e) { return { error: e.message }; }
    }

    // ── SHELL ────────────────────────────────────────────────────────
    case 'shell.safe': {
      const cmd  = params.command || '';
      const safe = isSafeShell(cmd);
      const cap  = safe ? 'shell.safe' : 'shell.danger';
      const p    = permEng.check(moduleId, cap, cmd);
      if (p.needsApproval) {
        const ok = await _requestApproval(moduleId, { tool: 'shell.danger', params, rationale });
        if (!ok) return { error: 'User denied approval for shell command' };
        const p2 = permEng.check(moduleId, 'shell.danger', cmd, { approved: true });
        if (!p2.allowed) return { error: p2.reason };
      } else if (!p.allowed) {
        return { error: `Command blocked — not in safe-shell allowlist.\nCommand: ${cmd}` };
      }
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: params.cwd || process.cwd(), timeout: 30_000, maxBuffer: 5 * 1024 * 1024, shell: true,
        });
        return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exit_code: 0 };
      } catch (e) {
        return { stdout: e.stdout?.trimEnd() || '', stderr: e.stderr?.trimEnd() || e.message, exit_code: e.code || 1 };
      }
    }

    // ── LLM ──────────────────────────────────────────────────────────
    case 'llm.infer': {
      const p = permEng.check(moduleId, 'llm.infer', null);
      if (!p.allowed) return { error: p.reason };
      try { return await llmOrch.infer(params.messages, params.model, params.options || {}); }
      catch (e) { return { error: e.message }; }
    }

    case 'llm.vision': {
      const p = permEng.check(moduleId, 'llm.infer', null);
      if (!p.allowed) return { error: p.reason };
      if (!params.image_base64) return { error: 'params.image_base64 required' };
      try { return await llmOrch.inferWithImage(params.prompt || 'Describe this image.', params.image_base64, params.options || {}); }
      catch (e) { return { error: e.message }; }
    }

    // ── DEVICE CONTROL ───────────────────────────────────────────────
    case 'device.control': {
      const p = permEng.check(moduleId, 'shell.safe', null);
      if (!p.allowed) return { error: p.reason };
      const { device_name, action } = params;
      if (!device_name || !action) return { error: 'device_name and action are required' };
      // Load devices from prefs file
      const prefsPath = require('path').join(require('os').homedir(), '.visrodeck', 'prefs.json');
      let devices = [];
      try { devices = JSON.parse(require('fs').readFileSync(prefsPath, 'utf8')).devices || []; } catch {}
      const device = devices.find(d => d.name.toLowerCase().includes(device_name.toLowerCase()));
      if (!device) return { error: `Device "${device_name}" not found. Register it in Automation settings.` };
      const cmd = action === 'off' ? device.offCmd : device.onCmd;
      const url = device.host.startsWith('http') ? `${device.host}${cmd}` : `http://${device.host}${cmd}`;
      try {
        const http  = require('http');
        const https = require('https');
        const lib   = url.startsWith('https') ? https : http;
        const result = await new Promise((res, rej) => {
          lib.get(url, { timeout: 5000 }, r => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => res({ ok: true, status: r.statusCode, body: d.slice(0, 200) }));
          }).on('error', e => rej(e));
        });
        return { ok: true, device: device.name, action, message: `${device.name} turned ${action}`, status: result.status };
      } catch(e) {
        return { error: `Device command failed: ${e.message}` };
      }
    }

    // ── SYSTEM LAUNCH ─────────────────────────────────────────────────
    case 'system.open_url': {
      const p = permEng.check(moduleId, 'system.launch', params.url);
      if (!p.allowed) return { error: p.reason };
      if (!params.url) return { error: 'params.url required' };
      return launcher.openUrl(params.url);
    }

    case 'system.search': {
      const p = permEng.check(moduleId, 'system.launch', params.query);
      if (!p.allowed) return { error: p.reason };
      if (!params.query) return { error: 'params.query required' };
      return launcher.searchWeb(params.query, params.engine || 'google');
    }

    case 'system.open_app': {
      const p = permEng.check(moduleId, 'system.launch', params.app);
      if (!p.allowed) return { error: p.reason };
      if (!params.app) return { error: 'params.app required' };
      return launcher.openApp(params.app);
    }

    case 'system.open_file': {
      const p = permEng.check(moduleId, 'system.launch', params.path);
      if (!p.allowed) return { error: p.reason };
      if (!params.path) return { error: 'params.path required' };
      return launcher.openFile(params.path);
    }

    case 'system.type': {
      const p = permEng.check(moduleId, 'system.type', params.text);
      if (p.needsApproval) {
        const ok = await _requestApproval(moduleId, { tool, params, rationale });
        if (!ok) return { error: 'User denied approval for system.type' };
        const p2 = permEng.check(moduleId, 'system.type', params.text, { approved: true });
        if (!p2.allowed) return { error: p2.reason };
      } else if (!p.allowed) return { error: p.reason };
      if (!params.text) return { error: 'params.text required' };
      return launcher.typeText(params.text);
    }

    default:
      return { error: `Unknown tool: '${tool}'` };
  }
}

// ── Approval helpers ─────────────────────────────────────────────────
function _requestApproval(moduleId, toolCall) {
  return new Promise((resolve) => {
    const approvalId = uuid();
    const timer = setTimeout(() => {
      approvalQueue.delete(approvalId);
      resolve(false);
    }, APPROVAL_TIMEOUT);
    approvalQueue.set(approvalId, { approvalId, moduleId, toolCall, timer, resolve });
    eventBus.publish('approval.requested', {
      approvalId, moduleId, tool: toolCall.tool, params: toolCall.params, rationale: toolCall.rationale || '',
    });
  });
}

function respondToApproval(approvalId, approved) {
  const e = approvalQueue.get(approvalId);
  if (!e) return false;
  clearTimeout(e.timer);
  approvalQueue.delete(approvalId);
  e.resolve(approved);
  return true;
}

function getPendingApprovals() {
  return Array.from(approvalQueue.values()).map(e => ({
    approvalId: e.approvalId, moduleId: e.moduleId, tool: e.toolCall.tool, params: e.toolCall.params,
  }));
}

module.exports = { execute, respondToApproval, getPendingApprovals };

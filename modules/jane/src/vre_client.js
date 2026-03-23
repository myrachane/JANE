'use strict';
// ws and uuid are lazy-loaded on first connect() call.
// This prevents "Cannot find module 'ws'" crashing the main process
// before npm install has run.
const path = require('path');
const fs   = require('fs');
const os   = require('os');

function _lazyRequire(name) {
  const roots = [
    path.join(__dirname, '..', '..', 'jane-ui', 'node_modules'),
    path.join(__dirname, '..', '..', '..', 'node_modules'),
    path.join(__dirname, '..', '..', '..', '..', 'node_modules'),
    path.join(__dirname, '..', '..', '..', '..', '..', 'node_modules'),
  ];
  for (const root of roots) {
    try { return require(path.join(root, name)); } catch {}
  }
  return require(name); // NODE_PATH fallback
}

class VREClient {
  constructor() {
    this.ws        = null;
    this.token     = null;
    this._pending  = new Map();
    this._handlers = new Map();
    this._uuid     = null;
  }

  connect(port) {
    const WebSocket = _lazyRequire('ws');
    const uuidPkg   = _lazyRequire('uuid');
    this._uuid = uuidPkg.v4;

    if (!port) {
      const lockFile = path.join(os.homedir(), '.visrodeck', 'vre.lock');
      if (!fs.existsSync(lockFile))
        return Promise.reject(new Error('VRE not running — start-vre.bat/.sh first'));
      port = JSON.parse(fs.readFileSync(lockFile, 'utf8')).port;
    }
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws.once('open',  resolve);
      this.ws.once('error', reject);
      this.ws.on('message', d => this._onMessage(d));
      this.ws.on('close', () => {
        this._emit('disconnected', {});
        for (const [id, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('VRE closed')); }
        this._pending.clear();
      });
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'error') p.reject(new Error(msg.payload?.message || 'VRE error'));
      else                      p.resolve(msg);
      return;
    }
    this._emit(msg.type, msg.payload);
  }

  _send(msg, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1)
        return reject(new Error('WebSocket not connected'));
      const id    = msg.id || (this._uuid?.() ?? Math.random().toString(36).slice(2));
      const full  = { ...msg, id, session: this.token };
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`VRE timeout for: ${msg.type}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(full));
    });
  }

  async register(manifest) {
    const res = await this._send({ type: 'register', payload: { manifest } });
    this.token = res.payload.token;
    return res.payload;
  }

  async toolCall(tool, params = {}, options = {}) {
    const callId = this._uuid?.() ?? Math.random().toString(36).slice(2);
    const res    = await this._send({
      type:    'tool_call',
      payload: { tool, params, rationale: options.rationale || '', call_id: callId }
    }, options.timeout || 180_000);
    return res.payload;
  }

  async respondApproval(approvalId, approved) {
    const res = await this._send({ type: 'approval_response', payload: { approvalId, approved } });
    return res.payload;
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return () => { const a = this._handlers.get(event)||[]; const i = a.indexOf(fn); if(i>-1) a.splice(i,1); };
  }

  _emit(event, data) {
    (this._handlers.get(event)||[]).forEach(fn => { try { fn(data); } catch {} });
    (this._handlers.get('*')  ||[]).forEach(fn => { try { fn(event, data); } catch {} });
  }

  disconnect() { if (this.ws) this.ws.close(); }
}

module.exports = VREClient;

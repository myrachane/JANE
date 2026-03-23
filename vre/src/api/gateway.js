'use strict';
const { v4: uuid } = require('uuid');
const sessionMgr   = require('./session');
const moduleReg    = require('../module_host/module_registry');
const toolExec     = require('../services/tool_executor');
const llmOrch      = require('../services/llm_orchestrator');
const eventBus     = require('../kernel/event_bus');
const audit        = require('../audit/logger');

function send(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch {}
}

async function handleMessage(ws, rawData) {
  let msg;
  try { msg = JSON.parse(rawData.toString()); }
  catch {
    send(ws, { type: 'error', payload: { code: 'INVALID_JSON', message: 'Malformed JSON' } });
    return;
  }

  const { id, session: token, type, payload = {} } = msg;

  // ── REGISTER ─────────────────────────────────────────────────────
  if (type === 'register') {
    const manifest = payload.manifest;
    if (!manifest?.id) {
      send(ws, { id, type: 'error', payload: { code: 'BAD_MANIFEST', message: 'manifest.id is required' } });
      return;
    }

    const sess = sessionMgr.createSession(manifest.id);
    ws._sessionToken = sess.token;   // store for disconnect cleanup
    moduleReg.register(manifest, ws);

    // Forward approval.requested events that belong to this module
    const unsub = eventBus.subscribe('approval.requested', ({ data }) => {
      if (data.moduleId === manifest.id) {
        send(ws, { type: 'approval_request', payload: data });
      }
    });
    ws._unsubApproval = unsub;

    send(ws, { id, type: 'registered', payload: { token: sess.token, moduleId: manifest.id } });
    audit.log(manifest.id, 'module.register', null, 'OK', { trust: manifest.trust_tier });
    return;
  }

  // ── Authenticate all other messages ───────────────────────────────
  const session = sessionMgr.validateSession(token);
  if (!session) {
    send(ws, { id, type: 'error', payload: { code: 'INVALID_SESSION', message: 'Invalid or expired session token' } });
    return;
  }
  const moduleId = session.moduleId;

  switch (type) {

    case 'ping':
      send(ws, { id, type: 'pong', payload: { ts: Date.now(), moduleId } });
      break;

    case 'tool_call': {
      const result = await toolExec.execute(moduleId, payload);
      send(ws, { id, type: 'tool_result', payload: result });
      break;
    }

    case 'approval_response': {
      const { approvalId, approved } = payload;
      const ok = toolExec.respondToApproval(approvalId, !!approved);
      send(ws, { id, type: 'approval_ack', payload: { ok, approvalId } });
      audit.log(moduleId, 'approval.response', approvalId, approved ? 'APPROVED' : 'DENIED', {});
      break;
    }

    case 'module_list':
      send(ws, { id, type: 'module_list_result', payload: moduleReg.list() });
      break;

    case 'audit_recent':
      send(ws, { id, type: 'audit_result', payload: require('../audit/logger').recent(payload.limit || 50) });
      break;

    case 'status':
      send(ws, {
        id, type: 'status_result',
        payload: {
          version: '0.1.0',
          uptime:  Math.floor(process.uptime()),
          pid:     process.pid,
          modules: moduleReg.list().length,
        }
      });
      break;

    default:
      send(ws, { id, type: 'error', payload: { code: 'UNKNOWN_TYPE', message: `Unknown type: '${type}'` } });
  }
}

function handleDisconnect(ws) {
  if (ws._unsubApproval) ws._unsubApproval();
  if (ws._sessionToken) {
    const sess = sessionMgr.validateSession(ws._sessionToken);
    if (sess) {
      moduleReg.unregister(sess.moduleId);
      sessionMgr.destroySession(ws._sessionToken);
    }
  }
}

module.exports = { handleMessage, handleDisconnect };

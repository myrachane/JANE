'use strict';
const permEng   = require('../services/permission_engine');
const arbiter   = require('../services/resource_arbiter');
const eventBus  = require('../kernel/event_bus');

const modules = new Map();

function register(manifest, wsClient) {
  const id = manifest.id;

  // Load permission policy
  permEng.loadPolicy(id, manifest);

  // Resource tracking
  arbiter.track(id, {
    max_cpu_percent: manifest.resource_limits?.max_cpu_percent,
    max_memory_mb:   manifest.resource_limits?.max_memory_mb,
  });

  const entry = {
    id,
    name:         manifest.name || id,
    version:      manifest.version || '0.0.0',
    trust:        manifest.trust_tier || 'sandboxed',
    ws:           wsClient,
    registeredAt: Date.now(),
    status:       'active',
  };

  modules.set(id, entry);
  eventBus.publish('module.registered', { id, name: entry.name, trust: entry.trust });
  console.log(`[ModuleRegistry] Registered: ${entry.name} (${id}) — trust: ${entry.trust}`);
  return entry;
}

function unregister(id) {
  const e = modules.get(id);
  if (!e) return;
  e.status = 'disconnected';
  modules.delete(id);
  arbiter.untrack(id);
  eventBus.publish('module.disconnected', { id });
  console.log(`[ModuleRegistry] Disconnected: ${id}`);
}

function get(id) { return modules.get(id); }

function list() {
  return Array.from(modules.values()).map(m => ({
    id:           m.id,
    name:         m.name,
    version:      m.version,
    trust:        m.trust,
    status:       m.status,
    registeredAt: m.registeredAt,
  }));
}

function getByWs(ws) {
  for (const m of modules.values()) {
    if (m.ws === ws) return m;
  }
  return null;
}

function sendTo(id, message) {
  const m = modules.get(id);
  if (!m?.ws) return false;
  try { m.ws.send(JSON.stringify(message)); return true; }
  catch { return false; }
}

module.exports = { register, unregister, get, getByWs, list, sendTo };

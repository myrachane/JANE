'use strict';

const services = new Map();

function register(id, instance) {
  services.set(id, { id, instance, startedAt: Date.now() });
  console.log(`[VRE] Service registered: ${id}`);
}

function get(id) {
  const entry = services.get(id);
  return entry ? entry.instance : null;
}

function list() {
  return Array.from(services.values()).map(s => ({
    id: s.id,
    startedAt: s.startedAt
  }));
}

module.exports = { register, get, list };

'use strict';
const eventBus = require('../../kernel/event_bus');

// Per-module resource tracking (Phase 1: monitoring only)
const resources = new Map();

function track(moduleId, limits = {}) {
  resources.set(moduleId, {
    moduleId,
    limits: {
      max_cpu_percent: limits.max_cpu_percent || 80,
      max_memory_mb:   limits.max_memory_mb   || 512,
    },
    usage: { cpu: 0, memory: 0 }
  });
}

function untrack(moduleId) {
  resources.delete(moduleId);
}

function report(moduleId, usage = {}) {
  const entry = resources.get(moduleId);
  if (!entry) return;
  entry.usage = { ...entry.usage, ...usage };

  if (usage.cpu && usage.cpu > entry.limits.max_cpu_percent) {
    eventBus.publish('resource.warning', { moduleId, type: 'cpu', usage: usage.cpu, limit: entry.limits.max_cpu_percent });
  }
  if (usage.memory && usage.memory > entry.limits.max_memory_mb) {
    eventBus.publish('resource.warning', { moduleId, type: 'memory', usage: usage.memory, limit: entry.limits.max_memory_mb });
  }
}

function summary() {
  return Array.from(resources.values()).map(r => ({
    moduleId: r.moduleId,
    limits:   r.limits,
    usage:    r.usage
  }));
}

module.exports = { track, untrack, report, summary };

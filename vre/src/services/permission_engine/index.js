'use strict';
const path  = require('path');
const audit = require('../../audit/logger');

const RISK = {
  'fs.read':        'LOW',   'fs.list':    'LOW',
  'fs.write':       'MEDIUM','fs.delete':  'HIGH',
  'fs.delete_recursive': 'HIGH',
  'shell.safe':     'LOW',   'shell.danger':'HIGH',
  'process.spawn':  'MEDIUM','process.kill':'HIGH',
  'llm.infer':      'LOW',   'module.communicate':'LOW',
  'network.outbound':'MEDIUM',
  'web.fetch':      'LOW',   'web.search': 'LOW',
  'voice.speak':    'LOW',   'voice.listen':'MEDIUM',
  'screen.capture': 'MEDIUM',
  'system.launch':  'MEDIUM','system.type':'HIGH',
};

const ALWAYS_APPROVE  = new Set(['shell.danger','fs.delete','fs.delete_recursive','process.kill','system.type']);
const WORKSPACE_ENFORCED = new Set(['fs.write','fs.delete','fs.delete_recursive']);

const policies = new Map();

function loadPolicy(moduleId, manifest) {
  policies.set(moduleId, {
    capabilities:    new Set(manifest.capabilities    || []),
    requireApproval: new Set(manifest.require_approval || []),
    deny:            new Set(manifest.deny            || []),
    workspace:       manifest.workspace || null,
  });
}

function check(moduleId, capability, resource, context = {}) {
  const policy = policies.get(moduleId);
  if (!policy) {
    audit.log(moduleId, capability, resource, 'DENY', { reason: 'no_policy' });
    return { allowed: false, reason: 'Module not registered' };
  }
  if (policy.deny.has(capability)) {
    audit.log(moduleId, capability, resource, 'DENY', { reason: 'explicit_deny' });
    return { allowed: false, reason: `'${capability}' denied for this module` };
  }
  if (!policy.capabilities.has(capability)) {
    audit.log(moduleId, capability, resource, 'DENY', { reason: 'not_declared' });
    return { allowed: false, reason: `'${capability}' not declared in manifest` };
  }
  if (resource && WORKSPACE_ENFORCED.has(capability) && policy.workspace) {
    const resolved = path.resolve(resource);
    const wsRoot   = path.resolve(policy.workspace);
    if (!resolved.startsWith(wsRoot + path.sep) && resolved !== wsRoot) {
      audit.log(moduleId, capability, resource, 'DENY', { reason: 'workspace_boundary' });
      return { allowed: false, reason: `Path outside workspace '${policy.workspace}'` };
    }
  }
  const needsApproval = ALWAYS_APPROVE.has(capability) || policy.requireApproval.has(capability);
  if (needsApproval && !context.approved) {
    audit.log(moduleId, capability, resource, 'PENDING_APPROVAL', {});
    return { allowed: false, needsApproval: true, reason: 'Requires user approval' };
  }
  audit.log(moduleId, capability, resource, 'ALLOW', {});
  return { allowed: true };
}

function getRisk(capability) { return RISK[capability] || 'UNKNOWN'; }
module.exports = { loadPolicy, check, getRisk };

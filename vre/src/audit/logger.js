'use strict';
/**
 * VRE Audit Logger — pure JS, zero native dependencies.
 * Writes to a newline-delimited JSON file (audit.jsonl).
 * Each line is one JSON audit record.
 */
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const DATA_DIR = process.env.VRE_DATA ||
  path.join(os.homedir(), '.visrodeck', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const MAX_MEM    = 5000;   // max entries kept in memory for fast queries

// In-memory ring buffer for fast recent() queries
const memLog = [];
let   writeSeq = 0;

// Load existing entries into memory on startup (up to MAX_MEM)
try {
  if (fs.existsSync(AUDIT_FILE)) {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8')
      .split('\n').filter(Boolean);
    const recent = lines.slice(-MAX_MEM);
    for (const line of recent) {
      try { memLog.push(JSON.parse(line)); } catch {}
    }
    writeSeq = lines.length;
  }
} catch {}

// Async write queue — prevents blocking the event loop
const writeQueue = [];
let   writing    = false;

function flushQueue() {
  if (writing || writeQueue.length === 0) return;
  writing = true;
  const batch = writeQueue.splice(0, writeQueue.length).join('\n') + '\n';
  fs.appendFile(AUDIT_FILE, batch, () => {
    writing = false;
    if (writeQueue.length > 0) flushQueue();
  });
}

/**
 * log(moduleId, action, resource, decision, details)
 * decision: 'ALLOW' | 'DENY' | 'PENDING_APPROVAL' | 'OK' | 'ERROR'
 */
function log(moduleId, action, resource, decision, details = {}) {
  const entry = {
    seq:       ++writeSeq,
    ts:        Date.now(),
    module_id: moduleId  || 'kernel',
    action:    action    || '',
    resource:  resource  || '',
    decision:  decision  || '',
    details:   details,
  };

  // Add to in-memory ring buffer
  memLog.push(entry);
  if (memLog.length > MAX_MEM) memLog.shift();

  // Queue async disk write
  writeQueue.push(JSON.stringify(entry));
  flushQueue();
}

/**
 * recent(limit) — returns the last N entries, newest first.
 */
function recent(limit = 100) {
  const n = Math.min(limit, memLog.length);
  return memLog.slice(-n).reverse();
}

/**
 * export(filePath) — writes a clean JSON array to a file.
 */
function exportAll(filePath) {
  fs.writeFileSync(filePath, JSON.stringify(memLog, null, 2));
}

module.exports = { log, recent, exportAll };

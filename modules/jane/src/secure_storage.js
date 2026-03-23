'use strict';
/**
 * Secure Storage — Jane
 * AES-256-GCM encrypted chat history stored on local disk.
 * Key is derived from device fingerprint — only readable on this machine.
 *
 * Stored at: ~/.visrodeck/chats/<id>.jenc
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const CHAT_DIR  = path.join(os.homedir(), '.visrodeck', 'chats');
const SEED      = 'VDT-CHAT-STORAGE-V2-EMTYPYIE';
const MAX_CHATS = 200;

// ── Device-bound encryption key ───────────────────────────────────────
function getKey() {
  const ifaces = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (!i.internal && i.mac && i.mac !== '00:00:00:00:00:00') { mac = i.mac; break; }
    }
    if (mac) break;
  }
  const raw = `${os.hostname()}|${mac}|${os.cpus()[0]?.model || ''}`;
  return crypto.pbkdf2Sync(SEED + raw, 'vdt-salt-v2', 80_000, 32, 'sha256');
}

const _key = (() => { try { return getKey(); } catch { return crypto.randomBytes(32); } })();

function enc(obj) {
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv('aes-256-gcm', _key, iv);
  const d   = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64');
}

function dec(b64) {
  const buf  = Buffer.from(b64, 'base64');
  const iv   = buf.slice(0, 12);
  const tag  = buf.slice(12, 28);
  const data = buf.slice(28);
  const dc   = crypto.createDecipheriv('aes-256-gcm', _key, iv);
  dc.setAuthTag(tag);
  return JSON.parse(Buffer.concat([dc.update(data), dc.final()]).toString('utf8'));
}

function chatPath(id) {
  return path.join(CHAT_DIR, `${id}.jenc`);
}

// ── Public API ────────────────────────────────────────────────────────
function saveChat(entry) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  fs.writeFileSync(chatPath(entry.id), enc(entry), 'utf8');
}

function loadChat(id) {
  try {
    const p = chatPath(id);
    if (!fs.existsSync(p)) return null;
    return dec(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function deleteChat(id) {
  try { fs.unlinkSync(chatPath(id)); } catch {}
}

function listChats() {
  try {
    fs.mkdirSync(CHAT_DIR, { recursive: true });
    const files = fs.readdirSync(CHAT_DIR)
      .filter(f => f.endsWith('.jenc'))
      .map(f => {
        const id = path.basename(f, '.jenc');
        try {
          const c = dec(fs.readFileSync(path.join(CHAT_DIR, f), 'utf8'));
          return {
            id:        c.id,
            title:     c.title || 'Conversation',
            preview:   c.preview || '',
            model:     c.model || '',
            createdAt: c.createdAt || 0,
            updatedAt: c.updatedAt || 0,
            msgCount:  c.msgCount || 0,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // Enforce max chat limit
    if (files.length > MAX_CHATS) {
      const toDelete = files.slice(MAX_CHATS);
      toDelete.forEach(c => deleteChat(c.id));
      return files.slice(0, MAX_CHATS);
    }
    return files;
  } catch { return []; }
}

function clearAll() {
  try {
    const files = fs.readdirSync(CHAT_DIR).filter(f => f.endsWith('.jenc'));
    files.forEach(f => fs.unlinkSync(path.join(CHAT_DIR, f)));
  } catch {}
}

function getStats() {
  const chats = listChats();
  const totalSize = chats.reduce((acc, c) => {
    try {
      return acc + fs.statSync(chatPath(c.id)).size;
    } catch { return acc; }
  }, 0);
  return {
    count:     chats.length,
    sizeBytes: totalSize,
    sizeKB:    Math.round(totalSize / 1024),
    encrypted: true,
  };
}

module.exports = { saveChat, loadChat, deleteChat, listChats, clearAll, getStats };

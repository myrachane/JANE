'use strict';
/**
 * Jane Activation — Visrodeck Technology
 * AES-256-GCM encrypted license · HMAC-SHA256 signed keys
 * 10 pre-generated keys · Per-key revocation support
 */
const crypto = require('crypto');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');

const MASTER_SECRET  = 'VDT-JANE-ACTIVATION-KEY-2025-EMTYPYIE';
const LIC_DIR        = path.join(os.homedir(), '.visrodeck');
const LIC_PATH       = path.join(LIC_DIR, 'jane.lic');
const REV_PATH       = path.join(LIC_DIR, 'revoked.json');    // revoked keys
const KEY_CHARS      = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateKey(seed) {
  const h = crypto.createHmac('sha256', MASTER_SECRET).update(seed).digest();
  let k = '';
  for (let i = 0; i < 16; i++) k += KEY_CHARS[h[i] % KEY_CHARS.length];
  return k.match(/.{4}/g).join('-');
}

// Pre-generated keys — these are fixed and version-stamped
const KEY_REGISTRY = [
  { id: 1,  key: generateKey('jane-key-1-visrodeck'),   label: 'Key 001', note: 'Internal Alpha' },
  { id: 2,  key: generateKey('jane-key-2-visrodeck'),   label: 'Key 002', note: 'Internal Beta'  },
  { id: 3,  key: generateKey('jane-key-3-visrodeck'),   label: 'Key 003', note: 'Developer'      },
  { id: 4,  key: generateKey('jane-key-4-visrodeck'),   label: 'Key 004', note: 'General'        },
  { id: 5,  key: generateKey('jane-key-5-visrodeck'),   label: 'Key 005', note: 'General'        },
  { id: 6,  key: generateKey('jane-key-6-visrodeck'),   label: 'Key 006', note: 'General'        },
  { id: 7,  key: generateKey('jane-key-7-visrodeck'),   label: 'Key 007', note: 'General'        },
  { id: 8,  key: generateKey('jane-key-8-visrodeck'),   label: 'Key 008', note: 'General'        },
  { id: 9,  key: generateKey('jane-key-9-visrodeck'),   label: 'Key 009', note: 'Reserved'       },
  { id: 10, key: generateKey('jane-key-10-visrodeck'),  label: 'Key 010', note: 'Reserved'       },
];

const ALL_KEYS     = new Set(KEY_REGISTRY.map(k => k.key));

// ── Revocation ────────────────────────────────────────────────────────
function getRevokedKeys() {
  try {
    if (fs.existsSync(REV_PATH)) return new Set(JSON.parse(fs.readFileSync(REV_PATH, 'utf8')));
  } catch {}
  return new Set();
}

function revokeKey(key) {
  const revoked = getRevokedKeys();
  revoked.add(key.toUpperCase().replace(/[\s-]/g, '').match(/.{4}/g)?.join('-') || key);
  fs.mkdirSync(LIC_DIR, { recursive: true });
  fs.writeFileSync(REV_PATH, JSON.stringify([...revoked]), 'utf8');
  return { success: true };
}

function isKeyActive(key) {
  if (!ALL_KEYS.has(key))    return false;
  if (getRevokedKeys().has(key)) return false;
  return true;
}

// ── Device fingerprint ────────────────────────────────────────────────
function getDeviceFingerprint() {
  const ifaces = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') { mac = iface.mac; break; }
    }
    if (mac) break;
  }
  const raw = [os.hostname(), mac, os.cpus()[0]?.model || 'cpu', process.platform].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// ── AES-256-GCM helpers ───────────────────────────────────────────────
function deriveEncKey(fp) {
  return crypto.pbkdf2Sync(MASTER_SECRET + fp, 'visrodeck-lic-salt-v2', 100_000, 32, 'sha256');
}
function encObj(obj, key) {
  const iv = crypto.randomBytes(16);
  const c  = crypto.createCipheriv('aes-256-gcm', key, iv);
  const e  = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), d: e.toString('hex'), v: 2 };
}
function decObj(blob, key) {
  const dc = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv,'hex'));
  dc.setAuthTag(Buffer.from(blob.tag,'hex'));
  return JSON.parse(Buffer.concat([dc.update(Buffer.from(blob.d,'hex')), dc.final()]).toString('utf8'));
}

// ── Validate key format ───────────────────────────────────────────────
function validateKey(rawKey) {
  const norm = rawKey.replace(/[-\s]/g,'').toUpperCase();
  if (norm.length !== 16) return { valid: false, reason: 'Key must be exactly 16 characters (XXXX-XXXX-XXXX-XXXX)' };
  const formatted = norm.match(/.{1,4}/g).join('-');
  if (!ALL_KEYS.has(formatted)) return { valid: false, reason: 'Invalid product key — please check and try again.' };
  if (!isKeyActive(formatted))  return { valid: false, reason: 'This key has been revoked.' };
  return { valid: true, key: formatted };
}

// ── Activate ──────────────────────────────────────────────────────────
function activate(rawKey) {
  const v = validateKey(rawKey);
  if (!v.valid) return { success: false, reason: v.reason };

  const fp  = getDeviceFingerprint();
  const now = Date.now();
  const sig = crypto.createHmac('sha256', MASTER_SECRET + v.key)
    .update(`${v.key}:${fp}:${Math.floor(now / 86400000)}`)
    .digest('hex');

  const license = { key: v.key, fingerprint: fp, activatedAt: now, product: 'JANE', vendor: 'Visrodeck Technology', version: '1.5.0', signature: sig };
  const encKey  = deriveEncKey(fp);

  fs.mkdirSync(LIC_DIR, { recursive: true });
  fs.writeFileSync(LIC_PATH, JSON.stringify(encObj(license, encKey), null, 2), 'utf8');
  return { success: true, license };
}

// ── Check license ─────────────────────────────────────────────────────
function checkLicense() {
  try {
    if (!fs.existsSync(LIC_PATH)) return { activated: false, reason: 'No license found.' };
    const blob = JSON.parse(fs.readFileSync(LIC_PATH, 'utf8'));
    const fp   = getDeviceFingerprint();
    let license;
    try { license = decObj(blob, deriveEncKey(fp)); }
    catch { return { activated: false, reason: 'License file corrupted or tampered.' }; }
    if (license.fingerprint !== fp) return { activated: false, reason: 'License bound to a different device.' };
    if (!isKeyActive(license.key))  return { activated: false, reason: 'Product key has been revoked.' };
    const expected = crypto.createHmac('sha256', MASTER_SECRET + license.key)
      .update(`${license.key}:${license.fingerprint}:${Math.floor(license.activatedAt/86400000)}`)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(license.signature,'hex'), Buffer.from(expected,'hex')))
      return { activated: false, reason: 'License signature verification failed.' };
    return { activated: true, license };
  } catch (err) {
    return { activated: false, reason: `License error: ${err.message}` };
  }
}

function deactivate() { try { fs.unlinkSync(LIC_PATH); } catch {} }
function getAllKeys()  { return KEY_REGISTRY.map(k => ({ ...k, revoked: getRevokedKeys().has(k.key) })); }
function getDeviceFP(){ return getDeviceFingerprint(); }

module.exports = { activate, checkLicense, deactivate, getAllKeys, revokeKey, isKeyActive, getDeviceFP };

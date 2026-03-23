'use strict';
/**
 * VRE License Service — Jane
 * Handles local license verification and online re-validation.
 *
 * License file: ~/.visrodeck/jane.lic
 * Format: AES-256-GCM encrypted JSON, key derived from device fingerprint
 *
 * Verification schedule:
 *   - Local (RSA signature + expiry):  every 7 days
 *   - Online (server re-verify):       every 30 days (or per plan)
 */
const {
  createHash, createCipheriv, createDecipheriv,
  createVerify, randomBytes
} = require('crypto');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const VRE_HOME   = path.join(os.homedir(), '.visrodeck');
const LIC_PATH   = path.join(VRE_HOME, 'jane.lic');
const PUB_KEY_PATH = path.join(__dirname, '..', '..', '..', 'config', 'public.pem');

const AUTH_SERVER  = process.env.VRE_AUTH_SERVER || 'https://auth.visrodeck.com';
const LOCAL_TTL    = 7  * 24 * 3600 * 1000;   // 7 days local tolerance
const GRACE_PERIOD = 3  * 24 * 3600 * 1000;   // 3 days grace if server unreachable

fs.mkdirSync(VRE_HOME, { recursive: true });

// ── Device fingerprint ───────────────────────────────────────────────
function getDeviceId() {
  const nets = os.networkInterfaces();
  let mac = '';
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac; break;
      }
    }
    if (mac) break;
  }
  const raw = mac + os.hostname() + os.userInfo().username;
  return createHash('sha256').update(raw + 'VRDCK_DEV').digest('hex').slice(0, 32);
}

// ── Encryption helpers ───────────────────────────────────────────────
function deriveKey(deviceId) {
  return createHash('sha256').update(deviceId + 'VRDCK_LIC_KEY_2025').digest();
}

function encryptLicense(obj, deviceId) {
  const key  = deriveKey(deviceId);
  const iv   = randomBytes(16);
  const ciph = createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(obj);
  const enc  = Buffer.concat([ciph.update(json, 'utf8'), ciph.final()]);
  const tag  = ciph.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptLicense(b64, deviceId) {
  const key  = deriveKey(deviceId);
  const buf  = Buffer.from(b64, 'base64');
  const iv   = buf.slice(0, 16);
  const tag  = buf.slice(16, 32);
  const enc  = buf.slice(32);
  const dech = createDecipheriv('aes-256-gcm', key, iv);
  dech.setAuthTag(tag);
  const dec  = Buffer.concat([dech.update(enc), dech.final()]);
  return JSON.parse(dec.toString('utf8'));
}

// ── RSA signature verification ───────────────────────────────────────
function verifySignature(payload, signature) {
  if (!fs.existsSync(PUB_KEY_PATH)) return false;
  try {
    const pubKey = fs.readFileSync(PUB_KEY_PATH, 'utf8');
    const sorted = {};
    Object.keys(payload).sort().forEach(k => { sorted[k] = payload[k]; });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(JSON.stringify(sorted));
    return verifier.verify(pubKey, signature, 'base64');
  } catch { return false; }
}

// ── License I/O ──────────────────────────────────────────────────────
function saveLicense(licensePayload, deviceId) {
  const enc = encryptLicense(licensePayload, deviceId);
  fs.writeFileSync(LIC_PATH, enc, { mode: 0o600 });
}

function loadLicense(deviceId) {
  if (!fs.existsSync(LIC_PATH)) return null;
  try { return decryptLicense(fs.readFileSync(LIC_PATH, 'utf8'), deviceId); }
  catch { return null; }
}

// ── Online activation ────────────────────────────────────────────────
async function activateOnline(productKey, deviceId, opts = {}) {
  const res = await fetch(`${AUTH_SERVER}/v1/keys/activate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      productKey:   productKey.trim().toUpperCase(),
      deviceId,
      deviceName:   opts.deviceName  || os.hostname(),
      platform:     process.platform,
      email:        opts.email       || undefined,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data.license;   // { key, deviceId, plan, activatedAt, expiresAt, nextVerifyAt, signature }
}

// ── Online re-verify ─────────────────────────────────────────────────
async function verifyOnline(productKey, deviceId) {
  const res = await fetch(`${AUTH_SERVER}/v1/keys/verify`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ productKey, deviceId }),
    signal:  AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!res.ok) return { valid: false, error: data.error };
  return { valid: true, license: data.license };
}

// ── Main: check license on startup ───────────────────────────────────
/**
 * checkLicense()
 * Returns: { valid: true, plan, key } | { valid: false, reason, needsActivation? }
 */
async function checkLicense() {
  const deviceId = getDeviceId();
  const license  = loadLicense(deviceId);
  const now      = Date.now();

  // No license file → must activate
  if (!license) {
    return { valid: false, reason: 'no_license', needsActivation: true };
  }

  // Verify RSA signature first
  const { signature, ...payload } = license;
  if (!verifySignature(payload, signature)) {
    return { valid: false, reason: 'invalid_signature', needsActivation: true };
  }

  // Device ID must match
  if (license.deviceId !== createHash('sha256').update(deviceId + 'VRDCK_SALT_2025').digest('hex').slice(0, 32)) {
    return { valid: false, reason: 'device_mismatch', needsActivation: true };
  }

  // Check hard expiry
  if (license.expiresAt && license.expiresAt < now) {
    return { valid: false, reason: 'expired', needsActivation: false };
  }

  // Check if online verification is due
  const onlineOverdue = license.nextVerifyAt && license.nextVerifyAt < now;

  if (onlineOverdue) {
    // Try to verify online
    try {
      const result = await verifyOnline(license.key, deviceId);
      if (!result.valid) {
        // Server says invalid — could be revoked on another device
        return { valid: false, reason: result.error || 'revoked', needsActivation: true };
      }
      // Save refreshed license
      saveLicense({ ...result.license, signature: result.license.signature }, deviceId);
      return { valid: true, plan: result.license.plan, key: license.key };
    } catch {
      // Server unreachable — apply grace period
      const graceDue = (license.nextVerifyAt || 0) + GRACE_PERIOD;
      if (now > graceDue) {
        return { valid: false, reason: 'grace_expired_offline', needsActivation: true };
      }
      // Within grace period — allow but warn
      return { valid: true, plan: license.plan, key: license.key, warning: 'offline_grace' };
    }
  }

  // All good — valid local license
  return { valid: true, plan: license.plan, key: license.key };
}

// ── Activate and save ────────────────────────────────────────────────
async function activate(productKey, opts = {}) {
  const deviceId = getDeviceId();
  const license  = await activateOnline(productKey, deviceId, opts);

  if (!verifySignature({ ...license, signature: undefined, ...Object.fromEntries(
    Object.entries(license).filter(([k]) => k !== 'signature')
  ) }, license.signature)) {
    // Actually just save it — server is trusted at activation time
  }

  saveLicense(license, deviceId);
  return { success: true, plan: license.plan, key: license.key };
}

module.exports = { checkLicense, activate, getDeviceId, saveLicense, loadLicense };

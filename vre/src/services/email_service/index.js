'use strict';
/**
 * VRE Email Service
 * Supports: Gmail, Outlook, Yahoo, custom SMTP
 * Config stored at ~/.visrodeck/email.config.json
 * 
 * Gmail setup:
 *   Enable 2FA → Google Account → Security → App Passwords → generate one
 *   Use that 16-char password (not your real password)
 *
 * Outlook setup:
 *   Settings → Mail → Sync → IMAP  (enable it)
 *   Use your real email + password, or app password if MFA is on
 */
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.visrodeck', 'email.config.json');

// ── Preset SMTP/IMAP configs for common providers ─────────────────
const PRESETS = {
  gmail: {
    smtp: { host: 'smtp.gmail.com',    port: 465, secure: true  },
    imap: { host: 'imap.gmail.com',    port: 993, secure: true  },
  },
  outlook: {
    smtp: { host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true },
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
  },
  yahoo: {
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  },
  hotmail: {
    smtp: { host: 'smtp.live.com',      port: 587, secure: false, requireTLS: true },
    imap: { host: 'outlook.live.com',   port: 993, secure: true  },
  },
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return null; }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function resolveSmtp(cfg) {
  const preset = PRESETS[cfg.provider?.toLowerCase()] || {};
  return {
    host:       cfg.smtp_host   || preset.smtp?.host,
    port:       cfg.smtp_port   || preset.smtp?.port || 587,
    secure:     cfg.smtp_secure ?? preset.smtp?.secure ?? false,
    requireTLS: cfg.requireTLS  ?? preset.smtp?.requireTLS ?? false,
  };
}

function resolveImap(cfg) {
  const preset = PRESETS[cfg.provider?.toLowerCase()] || {};
  return {
    host:   cfg.imap_host || preset.imap?.host,
    port:   cfg.imap_port || preset.imap?.port || 993,
    secure: cfg.imap_secure ?? preset.imap?.secure ?? true,
  };
}

// ── SEND ─────────────────────────────────────────────────────────
async function send({ to, subject, body, cc, bcc, html }) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch { throw new Error('nodemailer not installed — run: npm install'); }

  const cfg = loadConfig();
  if (!cfg) throw new Error(
    'Email not configured. Ask Jane to configure email first, ' +
    `or create ${CONFIG_PATH} manually.`
  );

  const smtp  = resolveSmtp(cfg);
  const trans = nodemailer.createTransport({
    host:       smtp.host,
    port:       smtp.port,
    secure:     smtp.secure,
    requireTLS: smtp.requireTLS,
    auth:       { user: cfg.email, pass: cfg.password },
    tls:        { rejectUnauthorized: false },
  });

  const info = await trans.sendMail({
    from:    cfg.display_name ? `"${cfg.display_name}" <${cfg.email}>` : cfg.email,
    to:      Array.isArray(to) ? to.join(', ') : to,
    cc:      cc  ? (Array.isArray(cc)  ? cc.join(', ')  : cc)  : undefined,
    bcc:     bcc ? (Array.isArray(bcc) ? bcc.join(', ') : bcc) : undefined,
    subject: subject || '(no subject)',
    text:    body    || '',
    html:    html    || undefined,
  });

  return {
    success:    true,
    message_id: info.messageId,
    accepted:   info.accepted,
    rejected:   info.rejected,
  };
}

// ── LIST ─────────────────────────────────────────────────────────
async function list({ folder = 'INBOX', limit = 20, unseen_only = false } = {}) {
  let ImapFlow;
  try { ImapFlow = require('imapflow').ImapFlow; }
  catch { throw new Error('imapflow not installed — run: npm install'); }

  const cfg  = loadConfig();
  if (!cfg) throw new Error('Email not configured.');
  const imap = resolveImap(cfg);

  const client = new ImapFlow({
    host:   imap.host,
    port:   imap.port,
    secure: imap.secure,
    auth:   { user: cfg.email, pass: cfg.password },
    logger: false,
    tls:    { rejectUnauthorized: false },
  });

  await client.connect();
  const emails = [];

  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const criteria = unseen_only ? ['UNSEEN'] : ['ALL'];
      const uids = await client.search(criteria, { uid: true });
      const recent = uids.slice(-limit);

      for await (const msg of client.fetch(recent.length ? recent : '1:*', {
        uid: true, flags: true, envelope: true, bodyStructure: false,
      }, { uid: true })) {
        emails.push({
          uid:     msg.uid,
          from:    msg.envelope.from?.[0]?.address || '',
          from_name: msg.envelope.from?.[0]?.name || '',
          to:      msg.envelope.to?.map(a => a.address).join(', ') || '',
          subject: msg.envelope.subject || '(no subject)',
          date:    msg.envelope.date?.toISOString() || '',
          seen:    msg.flags.has('\\Seen'),
          flagged: msg.flags.has('\\Flagged'),
        });
        if (emails.length >= limit) break;
      }
    } finally { lock.release(); }
  } finally { await client.logout(); }

  return {
    folder,
    count:  emails.length,
    emails: emails.reverse(),  // newest first
  };
}

// ── READ ─────────────────────────────────────────────────────────
async function read({ uid, folder = 'INBOX' }) {
  let ImapFlow;
  try { ImapFlow = require('imapflow').ImapFlow; }
  catch { throw new Error('imapflow not installed — run: npm install'); }

  const cfg  = loadConfig();
  if (!cfg) throw new Error('Email not configured.');
  const imap = resolveImap(cfg);

  const client = new ImapFlow({
    host:   imap.host,
    port:   imap.port,
    secure: imap.secure,
    auth:   { user: cfg.email, pass: cfg.password },
    logger: false,
    tls:    { rejectUnauthorized: false },
  });

  await client.connect();
  let result = null;

  try {
    const lock = await client.getMailboxLock(folder);
    try {
      for await (const msg of client.fetch(String(uid), {
        uid: true, flags: true, envelope: true,
        bodyParts: ['TEXT', '1', '2'],
        source: true,
      }, { uid: true })) {
        // Parse body from source
        let bodyText = '';
        if (msg.source) {
          const raw = msg.source.toString();
          // Grab everything after the headers (double newline)
          const bodyStart = raw.indexOf('\r\n\r\n');
          if (bodyStart > -1) {
            bodyText = raw.slice(bodyStart + 4)
              // Basic quoted-printable decode
              .replace(/=\r\n/g, '')
              .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
              // Strip HTML if present
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s{3,}/g, '\n\n')
              .trim();
          }
        }

        // Truncate very long emails
        if (bodyText.length > 8000) bodyText = bodyText.slice(0, 8000) + '\n\n... [truncated]';

        result = {
          uid:       msg.uid,
          from:      msg.envelope.from?.[0]?.address || '',
          from_name: msg.envelope.from?.[0]?.name    || '',
          to:        msg.envelope.to?.map(a => a.address).join(', ') || '',
          cc:        msg.envelope.cc?.map(a => a.address).join(', ') || '',
          subject:   msg.envelope.subject || '(no subject)',
          date:      msg.envelope.date?.toISOString() || '',
          seen:      msg.flags.has('\\Seen'),
          body:      bodyText,
        };
        break;
      }
    } finally { lock.release(); }
  } finally { await client.logout(); }

  if (!result) throw new Error(`Email UID ${uid} not found in ${folder}`);
  return result;
}

// ── CONFIGURE ────────────────────────────────────────────────────
function configure(params) {
  const existing = loadConfig() || {};
  const updated  = { ...existing, ...params };
  saveConfig(updated);
  return { success: true, config_path: CONFIG_PATH, provider: updated.provider || 'custom' };
}

function getStatus() {
  const cfg = loadConfig();
  if (!cfg) return { configured: false, config_path: CONFIG_PATH };
  return {
    configured:    true,
    email:         cfg.email,
    provider:      cfg.provider || 'custom',
    display_name:  cfg.display_name || '',
    config_path:   CONFIG_PATH,
    smtp_host:     resolveSmtp(cfg).host,
    imap_host:     resolveImap(cfg).host,
  };
}

module.exports = { send, list, read, configure, getStatus, PRESETS };

'use strict';
/**
 * Jane Memory Store
 * Persists key facts extracted from conversations across sessions.
 * Facts are injected into every new chat as personal context.
 *
 * Stored at: ~/.visrodeck/memory.enc  (AES-256-GCM encrypted)
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const MEM_DIR  = path.join(os.homedir(), '.visrodeck');
const MEM_PATH = path.join(MEM_DIR, 'memory.enc');
const MEM_KEY_SEED = 'VDT-MEM-V1-EMTYPYIE-2025';
const MAX_FACTS = 120;

// ── Encryption helpers ────────────────────────────────────────────────
function getEncKey() {
  const salt = os.hostname() + os.cpus()[0]?.model || 'default';
  return crypto.pbkdf2Sync(MEM_KEY_SEED, salt, 50_000, 32, 'sha256');
}

function encMem(obj) {
  const key = getEncKey();
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({
    iv:  iv.toString('hex'),
    tag: c.getAuthTag().toString('hex'),
    d:   enc.toString('hex'),
    v:   1,
  });
}

function decMem(raw) {
  const blob = JSON.parse(raw);
  const key  = getEncKey();
  const iv   = Buffer.from(blob.iv, 'hex');
  const tag  = Buffer.from(blob.tag, 'hex');
  const data = Buffer.from(blob.d, 'hex');
  const dc   = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dc.setAuthTag(tag);
  return JSON.parse(Buffer.concat([dc.update(data), dc.final()]).toString('utf8'));
}

// ── In-memory cache ───────────────────────────────────────────────────
let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(MEM_PATH)) {
      _cache = decMem(fs.readFileSync(MEM_PATH, 'utf8'));
    }
  } catch {}
  if (!_cache) {
    _cache = {
      facts:    [],   // [{ key, value, updatedAt, source }]
      profile:  {},   // { name, age, occupation, ... }
      projects: [],   // [{ name, desc, tech, updatedAt }]
    };
  }
  return _cache;
}

function save() {
  fs.mkdirSync(MEM_DIR, { recursive: true });
  fs.writeFileSync(MEM_PATH, encMem(_cache), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────
function getAll() {
  return load();
}

function getContextBlock() {
  const mem = load();
  if (!mem.facts.length && !Object.keys(mem.profile).length && !mem.projects.length) return '';

  const lines = ['═══════════════════════════════════════════════'];
  lines.push('JANE MEMORY — WHAT YOU KNOW ABOUT THIS USER');
  lines.push('═══════════════════════════════════════════════');

  if (Object.keys(mem.profile).length) {
    lines.push('User Profile:');
    for (const [k, v] of Object.entries(mem.profile)) {
      lines.push(`  ${k}: ${v}`);
    }
  }

  if (mem.projects.length) {
    lines.push('Active Projects:');
    mem.projects.forEach(p => lines.push(`  • ${p.name}: ${p.desc} (${p.tech})`));
  }

  if (mem.facts.length) {
    lines.push('Remembered Facts:');
    mem.facts.slice(0, 40).forEach(f => lines.push(`  • ${f.key}: ${f.value}`));
  }

  lines.push('');
  lines.push('Use this context naturally. Do not announce you are reading memory.');
  lines.push('If the user mentions something related, connect it to what you know.');
  lines.push('═══════════════════════════════════════════════');
  return lines.join('\n');
}

/**
 * extractAndStore — called after each LLM response.
 * Asks the LLM to extract memorable facts from the conversation,
 * then merges them into persistent memory.
 */
async function extractAndStore(messages, inferFn, model) {
  if (!messages || messages.length < 2) return;

  // Only extract from user messages
  const userMessages = messages
    .filter(m => m.role === 'user')
    .map(m => `User: ${m.content || m.text || ''}`)
    .join('\n');

  if (userMessages.length < 20) return; // too short to bother

  const extractPrompt = `You are a memory extractor. From the following conversation, extract any personal facts about the user.

Rules:
- Only extract REAL stated facts (name, age, job, projects, preferences, hobbies, tech stack, family, location, etc.)
- Do NOT extract guesses or things Jane said
- Be concise — value should be under 60 chars
- Return ONLY valid JSON, nothing else
- Format: {"profile":{"name":"...","occupation":"..."},"projects":[{"name":"...","desc":"...","tech":"..."}],"facts":[{"key":"...","value":"..."}]}
- All fields are optional — only include if clearly stated
- Maximum 5 facts per category

Conversation:
${userMessages.slice(0, 2000)}

JSON only:`;

  try {
    const res = await inferFn([
      { role: 'user', content: extractPrompt }
    ], model, { temperature: 0.1, max_tokens: 400 });

    const text = res.content?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const extracted = JSON.parse(jsonMatch[0]);
    const mem = load();
    const now = Date.now();

    // Merge profile
    if (extracted.profile && typeof extracted.profile === 'object') {
      for (const [k, v] of Object.entries(extracted.profile)) {
        if (v && String(v).length < 80) mem.profile[k.toLowerCase()] = String(v);
      }
    }

    // Merge projects
    if (Array.isArray(extracted.projects)) {
      extracted.projects.forEach(p => {
        if (!p.name) return;
        const existing = mem.projects.findIndex(x => x.name.toLowerCase() === p.name.toLowerCase());
        if (existing >= 0) {
          mem.projects[existing] = { ...mem.projects[existing], ...p, updatedAt: now };
        } else {
          mem.projects.push({ ...p, updatedAt: now });
        }
      });
      if (mem.projects.length > 20) mem.projects = mem.projects.slice(-20);
    }

    // Merge facts
    if (Array.isArray(extracted.facts)) {
      extracted.facts.forEach(f => {
        if (!f.key || !f.value) return;
        const existing = mem.facts.findIndex(x => x.key.toLowerCase() === f.key.toLowerCase());
        if (existing >= 0) {
          mem.facts[existing] = { key: f.key, value: f.value, updatedAt: now };
        } else {
          mem.facts.push({ key: f.key, value: f.value, updatedAt: now });
        }
      });
      if (mem.facts.length > MAX_FACTS) mem.facts = mem.facts.slice(-MAX_FACTS);
    }

    save();
  } catch {
    // Silently fail — memory extraction is non-critical
  }
}

function clearAll() {
  _cache = { facts: [], profile: {}, projects: [] };
  try { fs.unlinkSync(MEM_PATH); } catch {}
}

function removeFact(key) {
  const mem = load();
  mem.facts = mem.facts.filter(f => f.key !== key);
  save();
}

module.exports = {
  getAll,
  getContextBlock,
  extractAndStore,
  clearAll,
  removeFact,
};

'use strict';
const crypto = require('crypto');

const sessions = new Map();
const SESSION_TTL = parseInt(process.env.VRE_SESSION_TTL_H || '24') * 3600 * 1000;

function createSession(moduleId) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token,
    moduleId,
    created: Date.now(),
    expires: Date.now() + SESSION_TTL
  };
  sessions.set(token, session);
  return session;
}

function validateSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function destroySession(token) {
  sessions.delete(token);
}

function listSessions() {
  return Array.from(sessions.values());
}

module.exports = { createSession, validateSession, destroySession, listSessions };

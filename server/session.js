// Signed-in sessions. A session is a signed token (JWT) holding the key and a
// session ID, kept in an HttpOnly cookie (see cookies.js). It's only valid
// while that session ID is still the key's current one - activating the key
// again anywhere starts a new session and ends this one - and only from the
// browser the key is locked to.

const jwt = require('jsonwebtoken');
const store = require('./store');
const { readSessionToken, readDeviceId, setSessionCookie } = require('./cookies');

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h - then the key is entered again

function start(req, res, key, sessionId) {
  const token = jwt.sign({ key, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: SESSION_TTL_SECONDS });
  setSessionCookie(req, res, token, SESSION_TTL_SECONDS);
}

function readPayload(req) {
  const token = readSessionToken(req);
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

const NO_SESSION = { ok: false, code: 'no_session', message: 'Enter your license key to continue.' };

/** Full check-in with the browser's hardware fingerprint (`rawFp`). */
async function check(req, rawFp) {
  const payload = readPayload(req);
  if (!payload) return NO_SESSION;
  return store.checkSession(payload.key, payload.sid, readDeviceId(req), rawFp ?? null);
}

// Loading the app pulls in several files at once, and each one is checked.
// A session that just passed is trusted for a few seconds, rather than
// asking the database the same question for every file.
const recentlyOk = new Map(); // sid -> expiry time (ms)
const CACHE_MS = 30 * 1000;

/** Lighter check for serving the app's files and the admin API: valid
 * session and the right browser, no fingerprint (a plain request can't carry
 * one). Returns { ok: true, key } or a failure. */
async function checkForFiles(req) {
  const payload = readPayload(req);
  if (!payload) return NO_SESSION;
  const cacheKey = `${payload.sid}|${readDeviceId(req)}`;
  if ((recentlyOk.get(cacheKey) || 0) > Date.now()) return { ok: true, key: payload.key };
  const result = await store.checkSession(payload.key, payload.sid, readDeviceId(req), undefined);
  if (!result.ok) return result;
  if (recentlyOk.size > 5000) recentlyOk.clear();
  recentlyOk.set(cacheKey, Date.now() + CACHE_MS);
  return { ok: true, key: payload.key };
}

module.exports = { start, check, checkForFiles, SESSION_TTL_SECONDS };

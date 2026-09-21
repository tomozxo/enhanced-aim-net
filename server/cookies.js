// Minimal cookie handling, no dependency (no cookie-parser). Two cookies:
//
//   r6sf_device   Long-lived random ID for "this browser". Keys are locked to
//                 it (plus the machine's hardware, see fingerprint.js).
//   r6sf_session  The signed-in session. HttpOnly, so page scripts can't read
//                 it and it can't be copied out with a bit of JavaScript.
//                 The server checks it before handing out the app itself.

const crypto = require('crypto');

const DEVICE_COOKIE = 'r6sf_device';
const SESSION_COOKIE = 'r6sf_session';
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 60 * 60;
const VALID_ID = /^[A-Za-z0-9_-]{16,64}$/;

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  });
  return out;
}

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

/** Adds a Set-Cookie header without clobbering one already set on this
 * response (both cookies can be set by the same request). */
function appendCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('Set-Cookie', [...list, value]);
}

/** The browser's device ID, or null if it doesn't have a valid one. */
function readDeviceId(req) {
  const id = parseCookies(req)[DEVICE_COOKIE];
  return id && VALID_ID.test(id) ? id : null;
}

/** Returns the existing device cookie if present and well-formed, otherwise
 * mints a new random one and sets it on the response. */
function getOrCreateDeviceId(req, res) {
  const existing = readDeviceId(req);
  if (existing) return existing;
  const id = crypto.randomBytes(24).toString('base64url');
  appendCookie(
    res,
    `${DEVICE_COOKIE}=${id}; Max-Age=${TEN_YEARS_SECONDS}; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`
  );
  return id;
}

function readSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || null;
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  appendCookie(
    res,
    `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`
  );
}

function clearSessionCookie(req, res) {
  appendCookie(res, `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}

module.exports = {
  parseCookies,
  readDeviceId,
  getOrCreateDeviceId,
  readSessionToken,
  setSessionCookie,
  clearSessionCookie,
  DEVICE_COOKIE,
  SESSION_COOKIE,
};

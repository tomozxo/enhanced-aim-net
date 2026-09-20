// Minimal cookie handling, no dependency (no cookie-parser) - just enough
// to identify "this browser" for device-locking license keys instead of
// locking to an IP address.

const crypto = require('crypto');

const COOKIE_NAME = 'r6sf_device';
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

/** Returns the existing device cookie if present and well-formed, otherwise
 * mints a new random one and sets it on the response (long-lived, HttpOnly
 * so page JS can't read/tamper with it, SameSite=Lax). */
function getOrCreateDeviceId(req, res) {
  const existing = parseCookies(req)[COOKIE_NAME];
  if (existing && VALID_ID.test(existing)) return existing;

  const id = crypto.randomBytes(24).toString('base64url');
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${id}; Max-Age=${TEN_YEARS_SECONDS}; Path=/; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`
  );
  return id;
}

module.exports = { getOrCreateDeviceId, parseCookies, COOKIE_NAME };

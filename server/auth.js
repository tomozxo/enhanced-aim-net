const express = require('express');
const store = require('./store');
const session = require('./session');
const { makeLimiter } = require('./rateLimit');
const { getOrCreateDeviceId, clearSessionCookie } = require('./cookies');

const router = express.Router();

// Caps activation attempts per IP so someone can't script through the key
// space. This is brute-force protection, separate from the license lock
// itself (which is per browser + hardware, not per IP) - rate limiting
// still makes sense keyed by IP regardless.
const rateLimited = makeLimiter({ max: 8, windowMs: 5 * 60 * 1000 });

// Turns any throw or rejected promise into a JSON 500 instead of an uncaught
// error that could kill the whole process (see server/index.js for the
// belt-and-braces process-level version of the same idea). The details go
// to the server log only - never back to the browser.
function wrap(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        console.error(`[auth] ${req.method} ${req.originalUrl} failed:`, err);
        if (!res.headersSent) res.status(500).json({ ok: false, message: 'Server error. Try again in a moment.' });
      });
  };
}

/** body: { key, fp } - fp is the machine's hardware fingerprint
 * (public/js/fingerprint.js). On success the session goes into an HttpOnly
 * cookie; nothing the page's scripts could copy is sent back. */
router.post(
  '/activate',
  wrap(async (req, res) => {
    const key = String(req.body?.key || '').trim().toUpperCase();

    if (!key) return res.status(400).json({ ok: false, message: 'Enter a license key.' });

    if (rateLimited(req.ip)) {
      return res.status(429).json({ ok: false, message: 'Too many attempts. Try again in a few minutes.' });
    }

    const deviceId = getOrCreateDeviceId(req, res);
    const result = await store.tryActivate(key, deviceId, req.body?.fp);
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 403;
      return res.status(status).json({ ok: false, code: result.code, message: result.message });
    }

    session.start(req, res, result.record.key, result.sessionId);
    res.json({
      ok: true,
      key: result.record.key,
      note: result.record.note,
      isAdmin: !!result.record.isAdmin,
    });
  })
);

/** body: { fp }. The app checks in with this every minute, so a session
 * that's been replaced (the key activated elsewhere) or is being used from
 * the wrong machine ends within a minute. */
router.post(
  '/verify',
  wrap(async (req, res) => {
    const result = await session.check(req, req.body?.fp);
    if (!result.ok) {
      clearSessionCookie(req, res);
      return res.status(401).json({ ok: false, code: result.code, message: result.message });
    }
    const r = result.record;
    res.json({ ok: true, key: r.key, note: r.note, isAdmin: !!r.isAdmin });
  })
);

router.post('/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

module.exports = router;

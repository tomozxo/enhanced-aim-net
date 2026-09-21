const express = require('express');
const jwt = require('jsonwebtoken');
const store = require('./store');
const { makeLimiter } = require('./rateLimit');
const { getOrCreateDeviceId } = require('./cookies');

const router = express.Router();

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h - short enough that a revoked/expired
// key stops working reasonably quickly, long enough not to nag legit users.

// Caps activation attempts per IP so someone can't script through the key
// space. This is brute-force protection, separate from the license lock
// itself (which is now per-device via cookie, not per-IP) - rate limiting
// still makes sense keyed by IP regardless.
const rateLimited = makeLimiter({ max: 8, windowMs: 5 * 60 * 1000 });

// Turns any throw or rejected promise into a JSON 500 instead of an uncaught
// error that could kill the whole process (see server/index.js for the
// belt-and-braces process-level version of the same idea). Handlers are
// async now that keys can live in a database.
function wrap(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        console.error(`[auth] ${req.method} ${req.originalUrl} failed:`, err);
        if (!res.headersSent) res.status(500).json({ ok: false, message: `Server error: ${err.message}` });
      });
  };
}

router.post(
  '/activate',
  wrap(async (req, res) => {
    const key = String(req.body?.key || '').trim().toUpperCase();

    if (!key) return res.status(400).json({ ok: false, message: 'Enter a license key.' });

    if (rateLimited(req.ip)) {
      return res.status(429).json({ ok: false, message: 'Too many attempts. Try again in a few minutes.' });
    }

    const deviceId = getOrCreateDeviceId(req, res);
    const result = await store.tryActivate(key, deviceId);
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 403;
      return res.status(status).json({ ok: false, message: result.message });
    }

    const token = jwt.sign({ key: result.record.key }, process.env.JWT_SECRET, {
      expiresIn: SESSION_TTL_SECONDS,
    });

    res.json({
      ok: true,
      token,
      expiresIn: SESSION_TTL_SECONDS,
      key: result.record.key,
      note: result.record.note,
      isAdmin: !!result.record.isAdmin,
    });
  })
);

router.post(
  '/verify',
  wrap(async (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, message: 'No session.' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ ok: false, message: 'Session expired. Re-activate your key.' });
    }

    const record = await store.findKey(payload.key);
    if (!record || record.status === 'revoked') {
      return res.status(401).json({ ok: false, message: 'This key is no longer valid.' });
    }
    if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
      return res.status(401).json({ ok: false, message: 'This key has expired.' });
    }

    const deviceId = getOrCreateDeviceId(req, res);
    if (record.lockedDeviceId && record.lockedDeviceId !== deviceId) {
      return res.status(401).json({ ok: false, message: 'This session is tied to a different browser/device.' });
    }

    await store.updateKey(record.key, { lastSeenAt: new Date().toISOString(), lastSeenDeviceId: deviceId });
    res.json({ ok: true, key: record.key, note: record.note, isAdmin: !!record.isAdmin });
  })
);

module.exports = router;

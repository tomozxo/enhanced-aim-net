const express = require('express');
const jwt = require('jsonwebtoken');
const store = require('./store');
const { makeLimiter } = require('./rateLimit');

const router = express.Router();

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h - short enough that a revoked/expired
// key stops working reasonably quickly, long enough not to nag legit users.

// Caps activation attempts per IP so someone can't script through the key space.
const rateLimited = makeLimiter({ max: 8, windowMs: 5 * 60 * 1000 });

function clientIp(req) {
  return req.ip;
}

// Turns any throw into a JSON 500 instead of an uncaught exception that
// could kill the whole process (see server/index.js for the belt-and-braces
// process-level version of the same idea).
function wrap(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      console.error(`[auth] ${req.method} ${req.originalUrl} failed:`, err);
      res.status(500).json({ ok: false, message: `Server error: ${err.message}` });
    }
  };
}

router.post(
  '/activate',
  wrap((req, res) => {
    const ip = clientIp(req);
    const key = String(req.body?.key || '').trim().toUpperCase();

    if (!key) return res.status(400).json({ ok: false, message: 'Enter a license key.' });

    if (rateLimited(ip)) {
      return res.status(429).json({ ok: false, message: 'Too many attempts. Try again in a few minutes.' });
    }

    const result = store.tryActivate(key, ip);
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 403;
      return res.status(status).json({ ok: false, message: result.message });
    }

    const token = jwt.sign({ key: result.record.key, ip }, process.env.JWT_SECRET, {
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
  wrap((req, res) => {
    const ip = clientIp(req);
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, message: 'No session.' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ ok: false, message: 'Session expired. Re-activate your key.' });
    }

    const record = store.findKey(payload.key);
    if (!record || record.status === 'revoked') {
      return res.status(401).json({ ok: false, message: 'This key is no longer valid.' });
    }
    if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
      return res.status(401).json({ ok: false, message: 'This key has expired.' });
    }
    if (record.lockedIp && record.lockedIp !== ip) {
      return res.status(401).json({ ok: false, message: 'This session is tied to a different network.' });
    }

    store.updateKey(record.key, { lastSeenAt: new Date().toISOString(), lastSeenIp: ip });
    res.json({ ok: true, key: record.key, note: record.note, isAdmin: !!record.isAdmin });
  })
);

module.exports = router;

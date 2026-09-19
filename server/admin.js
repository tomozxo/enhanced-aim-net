const express = require('express');
const jwt = require('jsonwebtoken');
const store = require('./store');
const { makeLimiter } = require('./rateLimit');

const router = express.Router();

// Caps FAILED auth attempts per IP so ADMIN_TOKEN (or a guessed admin
// session) can't be brute-forced. Only failures count - a legitimate signed
// in admin clicking around the panel never touches this, no matter how many
// requests that generates.
const rateLimited = makeLimiter({ max: 15, windowMs: 5 * 60 * 1000 });

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (token) {
    // Plan A: the raw ADMIN_TOKEN from .env - always works, handy for scripts.
    if (process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) {
      req.adminContext = { viaRawToken: true };
      return next();
    }

    // Plan B: a normal license session whose key is flagged as an admin key.
    // Deliberately NOT checking lockedIp here (unlike the regular customer
    // key flow in auth.js) - on platforms like Render, the IP Express sees
    // for the same visitor can vary between requests depending on which
    // edge/proxy handled it, even with trust proxy configured correctly.
    // For a customer key that's a feature (stops casual sharing); for the
    // site owner's own admin session it's just a way to randomly lock
    // yourself out of your own panel, which isn't worth the tradeoff here.
    // isAdmin + not-revoked + not-expired is still required.
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const record = store.findKey(payload.key);
      const stillValid =
        record &&
        record.isAdmin &&
        record.status !== 'revoked' &&
        (!record.expiresAt || new Date(record.expiresAt).getTime() >= Date.now());
      if (stillValid) {
        req.adminContext = { key: record.key, note: record.note, lockedIp: record.lockedIp };
        return next();
      }
    } catch {
      /* not a valid session token either - falls through to the 401 below */
    }
  }

  // Only reject paths land here - this is what actually gets rate-limited.
  if (rateLimited(req.ip)) {
    return res.status(429).json({ ok: false, message: 'Too many attempts. Try again in a few minutes.' });
  }
  return res.status(401).json({ ok: false, message: 'Invalid admin token.' });
}

router.use(requireAdmin);

// Catches anything a handler throws and turns it into a JSON 500 instead of
// Express's default HTML error page (which broke the client's res.json()
// parsing and showed up as a bare "Failed to fetch"/network-looking error)
// or, worse, an uncaught exception that could take the process down.
function wrap(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      console.error(`[admin] ${req.method} ${req.originalUrl} failed:`, err);
      res.status(500).json({ ok: false, message: `Server error: ${err.message}` });
    }
  };
}

router.get(
  '/me',
  wrap((req, res) => {
    res.json({ ok: true, ...req.adminContext });
  })
);

router.get(
  '/keys',
  wrap((req, res) => {
    res.json({ ok: true, keys: store.listKeys() });
  })
);

router.post(
  '/keys',
  wrap((req, res) => {
    const { note, expiresInDays, isAdmin } = req.body || {};
    const record = store.createKey({
      note,
      expiresInDays: expiresInDays ? Number(expiresInDays) : null,
      isAdmin: !!isAdmin,
    });
    res.json({ ok: true, key: record });
  })
);

router.post(
  '/keys/:key/revoke',
  wrap((req, res) => {
    const updated = store.revokeKey(req.params.key.toUpperCase());
    if (!updated) return res.status(404).json({ ok: false, message: 'Key not found.' });
    res.json({ ok: true, key: updated });
  })
);

router.post(
  '/keys/:key/unlock',
  wrap((req, res) => {
    const updated = store.unlockKey(req.params.key.toUpperCase());
    if (!updated) return res.status(404).json({ ok: false, message: 'Key not found.' });
    res.json({ ok: true, key: updated });
  })
);

router.delete(
  '/keys/:key',
  wrap((req, res) => {
    const removed = store.deleteKey(req.params.key.toUpperCase());
    if (!removed) return res.status(404).json({ ok: false, message: 'Key not found.' });
    res.json({ ok: true });
  })
);

module.exports = router;

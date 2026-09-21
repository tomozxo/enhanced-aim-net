const express = require('express');
const store = require('./store');
const session = require('./session');
const { makeLimiter } = require('./rateLimit');

const router = express.Router();

// Caps FAILED auth attempts per IP so ADMIN_TOKEN (or a guessed admin
// session) can't be brute-forced. Only failures count - a legitimate signed
// in admin clicking around the panel never touches this, no matter how many
// requests that generates.
const rateLimited = makeLimiter({ max: 15, windowMs: 5 * 60 * 1000 });

// Express 4 doesn't catch errors from async middleware, so this one catches
// its own: a database hiccup comes back as a 500 saying so, rather than
// being mistaken for a bad token (and counted against the rate limit).
async function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    // Plan A: the raw ADMIN_TOKEN from .env - always works, handy for scripts,
    // and the way back in if you ever lock your admin key to an old PC.
    if (token && process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) {
      req.adminContext = { viaRawToken: true };
      return next();
    }

    // Plan B: the signed-in session cookie of an admin key. Same rules as
    // any key - the current session, from the browser it's locked to.
    const check = await session.checkForFiles(req);
    if (check.ok) {
      const record = await store.findKey(check.key);
      if (record && record.isAdmin) {
        req.adminContext = { key: record.key, note: record.note, lockedDeviceId: record.lockedDeviceId };
        return next();
      }
    }

    // Only reject paths land here - this is what actually gets rate-limited.
    if (rateLimited(req.ip)) {
      return res.status(429).json({ ok: false, message: 'Too many attempts. Try again in a few minutes.' });
    }
    return res.status(401).json({ ok: false, message: 'Invalid admin token.' });
  } catch (err) {
    console.error(`[admin] auth check for ${req.method} ${req.originalUrl} failed:`, err);
    if (!res.headersSent) res.status(500).json({ ok: false, message: `Server error: ${err.message}` });
  }
}

router.use(requireAdmin);

// Catches anything a handler throws or rejects with and turns it into a JSON
// 500 instead of Express's default HTML error page (which broke the client's
// res.json() parsing and showed up as a bare "Failed to fetch"/network-looking
// error) or, worse, an uncaught error that could take the process down.
function wrap(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        console.error(`[admin] ${req.method} ${req.originalUrl} failed:`, err);
        if (!res.headersSent) res.status(500).json({ ok: false, message: `Server error: ${err.message}` });
      });
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
  wrap(async (req, res) => {
    res.json({ ok: true, keys: (await store.listKeys()).map(forPanel) });
  })
);

/** What the panel shows for a key. The session ID and hardware hashes stay
 * on the server; the panel only needs to know whether a lock is in place. */
function forPanel(k) {
  const { currentSessionId, lockedFingerprint, ...rest } = k;
  return {
    ...rest,
    hardwareLocked: !!lockedFingerprint,
    gpuCount: lockedFingerprint && Array.isArray(lockedFingerprint.gpus) ? lockedFingerprint.gpus.length : 0,
  };
}

router.post(
  '/keys',
  wrap(async (req, res) => {
    const { note, expiresInDays, isAdmin } = req.body || {};
    const record = await store.createKey({
      note,
      expiresInDays: expiresInDays ? Number(expiresInDays) : null,
      isAdmin: !!isAdmin,
    });
    res.json({ ok: true, key: forPanel(record) });
  })
);

router.post(
  '/keys/:key/revoke',
  wrap(async (req, res) => {
    const updated = await store.revokeKey(req.params.key.toUpperCase());
    if (!updated) return res.status(404).json({ ok: false, message: 'Key not found.' });
    res.json({ ok: true, key: forPanel(updated) });
  })
);

router.post(
  '/keys/:key/unlock',
  wrap(async (req, res) => {
    const updated = await store.unlockKey(req.params.key.toUpperCase());
    if (!updated) return res.status(404).json({ ok: false, message: 'Key not found.' });
    res.json({ ok: true, key: forPanel(updated) });
  })
);

router.delete(
  '/keys/:key',
  wrap(async (req, res) => {
    const removed = await store.deleteKey(req.params.key.toUpperCase());
    if (!removed) return res.status(404).json({ ok: false, message: 'Key not found.' });
    res.json({ ok: true });
  })
);

module.exports = router;

const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const session = require('./session');
const { makeLimiter } = require('./rateLimit');

const router = express.Router();

// Caps FAILED admin sign-ins so ADMIN_TOKEN (or a guessed admin session)
// can't be brute-forced. Only failures count - a signed-in admin clicking
// around the panel never touches these, however many requests that makes.
// Two limits: per IP, and across everyone. An IP can be faked (a request
// can claim any address), so the site-wide one is the one that can't be
// dodged; it only ever turns away requests that were already going to fail.
const WINDOW_MS = 5 * 60 * 1000;
const rateLimitedIp = makeLimiter({ max: 15, windowMs: WINDOW_MS });
const rateLimitedAll = makeLimiter({ max: 100, windowMs: WINDOW_MS });

/** Compares a submitted token with ADMIN_TOKEN in constant time, so response
 * timing can't reveal how much of a guess was right. Hashing first makes
 * both sides the same length, which timingSafeEqual needs. */
function isAdminToken(candidate) {
  const real = process.env.ADMIN_TOKEN;
  if (!candidate || !real) return false;
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(String(real)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The PC's hardware fingerprint, sent by the admin panel with every
 * request (base64 JSON in X-Enhanced-Fp). */
function fingerprintFrom(req) {
  const header = req.headers['x-enhanced-fp'];
  if (typeof header !== 'string' || !header || header.length > 4000) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Express 4 doesn't catch errors from async middleware, so this one catches
// its own: a database hiccup comes back as a 500, rather than being mistaken
// for a bad token (and counted against the rate limit).
async function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    // Plan A: the raw ADMIN_TOKEN from .env - always works, handy for scripts,
    // and the way back in if you ever lock your admin key to an old PC.
    if (token && isAdminToken(token)) {
      req.adminContext = { viaRawToken: true };
      return next();
    }

    // Plan B: an admin key's signed-in session - with the full check every
    // time, hardware included. So admin cookies copied off the owner's PC
    // don't work anywhere else, even for a moment.
    const check = await session.check(req, fingerprintFrom(req));
    if (check.ok && check.record.isAdmin) {
      const r = check.record;
      req.adminContext = { key: r.key, note: r.note, lockedDeviceId: r.lockedDeviceId };
      return next();
    }

    // Only reject paths land here - this is what actually gets rate-limited.
    // Both counters are bumped on every failure (| rather than ||).
    if (rateLimitedIp(req.ip) | rateLimitedAll('all')) {
      return res.status(429).json({ ok: false, message: 'Too many attempts. Try again in a few minutes.' });
    }
    return res.status(401).json({ ok: false, message: 'Invalid admin token.' });
  } catch (err) {
    console.error(`[admin] auth check for ${req.method} ${req.originalUrl} failed:`, err);
    if (!res.headersSent) res.status(500).json({ ok: false, message: 'Server error. Try again in a moment.' });
  }
}

router.use(requireAdmin);

// Catches anything a handler throws or rejects with and turns it into a JSON
// 500 instead of Express's default HTML error page (which broke the client's
// res.json() parsing and showed up as a bare "Failed to fetch"/network-looking
// error) or, worse, an uncaught error that could take the process down. The
// details go to the server log only - never back to the browser.
function wrap(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        console.error(`[admin] ${req.method} ${req.originalUrl} failed:`, err);
        if (!res.headersSent) res.status(500).json({ ok: false, message: 'Server error. Try again in a moment.' });
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

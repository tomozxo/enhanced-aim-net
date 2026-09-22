// Small in-memory limiter, no dependency. Resets on server restart, which is
// fine at this scale - swap for a real store if you ever run multiple
// instances behind a load balancer.

// Past this many tracked addresses, expired entries are swept out - so a
// flood from lots of different addresses can't grow the map until the
// server runs out of memory.
const SWEEP_AT = 10000;
const HARD_CAP = 50000;

function makeLimiter({ max, windowMs }) {
  const attempts = new Map(); // ip -> { count, resetAt }
  return function limited(ip) {
    const now = Date.now();
    if (attempts.size >= SWEEP_AT) {
      for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
      if (attempts.size >= HARD_CAP) attempts.clear();
    }
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

const IP_PATTERN = /^[0-9a-fA-F:.]{3,45}$/;

/**
 * The visitor's real address, for rate limiting. Render sits behind
 * Cloudflare, which puts the address it saw in CF-Connecting-IP and
 * overwrites any value a visitor sends in that header, so it can't be
 * faked. req.ip comes from X-Forwarded-For, which can: a visitor can send
 * their own and the proxies add to it rather than replace it, which let one
 * person claim a new address on every request and dodge per-IP limits.
 * req.ip is only the fallback for when the header isn't there (running
 * locally).
 */
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && IP_PATTERN.test(cf.trim())) return cf.trim();
  return req.ip;
}

function middleware({ max, windowMs, message }) {
  const limited = makeLimiter({ max, windowMs });
  return (req, res, next) => {
    if (limited(clientIp(req))) {
      return res.status(429).json({ ok: false, message: message || 'Too many requests. Try again shortly.' });
    }
    next();
  };
}

module.exports = { makeLimiter, middleware, clientIp };

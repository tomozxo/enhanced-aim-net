// Small in-memory limiter, no dependency. Resets on server restart, which is
// fine at this scale - swap for a real store if you ever run multiple
// instances behind a load balancer.

function makeLimiter({ max, windowMs }) {
  const attempts = new Map(); // ip -> { count, resetAt }
  return function limited(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

function middleware({ max, windowMs, message }) {
  const limited = makeLimiter({ max, windowMs });
  return (req, res, next) => {
    if (limited(req.ip)) {
      return res.status(429).json({ ok: false, message: message || 'Too many attempts. Try again shortly.' });
    }
    next();
  };
}

module.exports = { makeLimiter, middleware };

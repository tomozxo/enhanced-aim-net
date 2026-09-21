require('dotenv').config();
const path = require('path');
const express = require('express');

const authRoutes = require('./auth');
const adminRoutes = require('./admin');
const store = require('./store');

if (!process.env.JWT_SECRET || !process.env.ADMIN_TOKEN) {
  console.error(
    'Missing JWT_SECRET or ADMIN_TOKEN. Copy .env.example to .env and fill in real values before starting the server.'
  );
  process.exit(1);
}

// A single bad request should never take the whole server down. Without
// this, an uncaught exception or rejected promise anywhere kills the whole
// Node process - every open connection drops (this is almost certainly what
// "Failed to fetch, then the site is completely unreachable" was: the
// process died). Log it loudly and keep serving everyone else.
process.on('uncaughtException', (err) => {
  console.error('[FATAL-ish] Uncaught exception (server is staying up):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL-ish] Unhandled promise rejection (server is staying up):', err);
});

const app = express();
// TRUST_PROXY_HOPS: "true" trusts the whole proxy chain and reads the
// left-most X-Forwarded-For entry as the real client IP - the safe default
// on a platform like Render where the exact number of proxy hops in front
// of the app isn't fixed/documented. A specific number (e.g. "1") is only
// safe if you've actually verified your host sits behind exactly that many
// hops. The license lock itself is cookie-based now (see server/cookies.js),
// not IP-based, so this only affects per-IP rate limiting and correct
// HTTPS detection for the device cookie's Secure flag.
const trustProxySetting = (process.env.TRUST_PROXY_HOPS || '').trim().toLowerCase();
if (trustProxySetting === 'true') {
  app.set('trust proxy', true);
} else {
  const trustHops = Number(trustProxySetting || 0);
  if (trustHops > 0) app.set('trust proxy', trustHops);
}

app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

// no-cache so a browser tab never serves a stale JS/CSS file after an
// update - avoids "I updated it but it still does the old broken thing"
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

// First-run bootstrap: on a totally fresh data/keys.json (e.g. a brand new
// deploy on a host with ephemeral storage, where any keys from a previous
// run are gone), mint one admin key automatically so you're never locked
// out - it only shows up once, right here in the logs.
if (store.listKeys().length === 0) {
  const record = store.createKey({ note: 'auto-bootstrapped on first run', isAdmin: true });
  console.log('='.repeat(60));
  console.log('No keys found - created a bootstrap ADMIN key:');
  console.log(`  ${record.key}`);
  console.log('Enter it on the site\'s activation screen to reach /admin.html.');
  console.log('='.repeat(60));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`enhanced.aim.net running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
});

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');

const authRoutes = require('./auth');
const adminRoutes = require('./admin');
const store = require('./store');
const session = require('./session');

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

// ---------- Static files ----------
// public/  the key screen, admin panel shell, styles - anyone can load these.
// private/ the app itself (app.html and its scripts). Only handed out to a
//          signed-in session from the browser its key is locked to. These
//          used to sit in public/, so anyone could download the whole tool
//          without a key.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PRIVATE_DIR = path.join(__dirname, '..', 'private');

/** Every file under a folder, as lower-case URL paths ("/js/app.js"). */
function listFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), `${prefix}/${entry.name}`)
      : [`${prefix}/${entry.name}`.toLowerCase()]
  );
}
const PRIVATE_FILES = new Set(listFiles(PRIVATE_DIR));

/** The file a request is asking for, normalised the same way the static
 * file server does it (decoded, "." and ".." resolved), in lower case. A
 * path this misses still can't reach a private file: those aren't in
 * public/, so the only way to them is through the check below. */
function requestedFile(req) {
  let decoded;
  try {
    decoded = decodeURIComponent(req.path);
  } catch {
    return null;
  }
  const parts = [];
  for (const seg of decoded.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`.toLowerCase();
}

// no-cache so a browser tab never serves a stale JS/CSS file after an
// update - avoids "I updated it but it still does the old broken thing".
// Private files are also marked "private" so no shared cache keeps a copy.
const servePrivate = express.static(PRIVATE_DIR, {
  index: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'private, no-cache'),
});

app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = requestedFile(req);
  if (!file || !PRIVATE_FILES.has(file)) return next();
  try {
    const check = await session.checkForFiles(req);
    if (check.ok) return servePrivate(req, res, next);
    if (file.endsWith('.html')) return res.redirect(302, '/');
    return res.status(401).type('text/plain').send('Sign in with your license key to load this.');
  } catch (err) {
    console.error(`[static] session check for ${req.path} failed:`, err);
    if (!res.headersSent) res.status(500).type('text/plain').send('Server error.');
  }
});

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

/** Sets up key storage, retrying for a while: a hosted database can take a
 * few seconds to answer, e.g. a Supabase project waking up. */
async function initStore() {
  const attempts = 6;
  for (let i = 1; i <= attempts; i++) {
    try {
      await store.init();
      return true;
    } catch (err) {
      console.error(`[store] couldn't reach key storage (attempt ${i}/${attempts}): ${err.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
  return false;
}

async function start() {
  console.log(`Key storage: ${store.backendName}`);
  const ready = await initStore();

  if (!ready) {
    // Start anyway so the site itself loads; logins will fail with a clear
    // "Server error" until the database is reachable. Check DATABASE_URL.
    console.error('[store] KEY STORAGE IS UNAVAILABLE - activations and the admin panel will fail until it is fixed.');
  } else if ((await store.listKeys()).length === 0) {
    // First-run bootstrap: with no keys at all (a brand new database, or a
    // wiped local file), mint one admin key so you're never locked out. With
    // a database this only ever happens once; the key lives on after that.
    const record = await store.createKey({ note: 'auto-bootstrapped on first run', isAdmin: true });
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
}

start().catch((err) => {
  console.error('[FATAL] Server failed to start:', err);
  process.exit(1);
});

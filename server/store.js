// License key store. Everything about keys - their format, how activation
// and device-locking work - lives here, on top of one of two backends:
//
//   store-pg.js    Postgres (e.g. Supabase), used when DATABASE_URL is set.
//                  Keys survive deploys, restarts and Render's free-tier sleep.
//   store-file.js  A JSON file, used otherwise. Fine locally, but on Render's
//                  free plan the file is wiped on every deploy and restart.
//
// Every function is async (the database needs it), so callers await them.

const crypto = require('crypto');
const fingerprint = require('./fingerprint');

const backend = process.env.DATABASE_URL ? require('./store-pg') : require('./store-file');

const newSessionId = () => crypto.randomBytes(16).toString('base64url');

// The three lengths a key can be sold as. The clock starts on first
// activation, not creation, so an unsold key never burns its time.
// Lifetime keys store no duration at all and never expire.
const PLANS = {
  '8h': { id: '8h', label: '8 hours', minutes: 480 },
  '1w': { id: '1w', label: '1 week', minutes: 7 * 24 * 60 },
  lifetime: { id: 'lifetime', label: 'Lifetime', minutes: null },
};

const isPlan = (plan) => typeof plan === 'string' && Object.prototype.hasOwnProperty.call(PLANS, plan);

/** Minutes for a plan id, or null for lifetime / anything unrecognised. */
function planMinutes(plan) {
  return isPlan(plan) ? PLANS[plan].minutes : null;
}

function formatKey(raw) {
  // raw: 16 chars -> R6S-XXXX-XXXX-XXXX-XXXX
  const groups = raw.match(/.{1,4}/g);
  return 'R6S-' + groups.join('-');
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity

function generateRawKey() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** Creates the storage (table or file) if it isn't there yet. */
async function init() {
  await backend.init();
}

async function createKey({ note = '', plan = 'lifetime', expiresInDays = null, isAdmin = false } = {}) {
  // plan is one of PLANS; expiresInDays is the older CLI form, still honoured.
  const durationMinutes = expiresInDays > 0 ? Math.round(expiresInDays * 24 * 60) : planMinutes(plan);
  // A clash between two random 16-character keys is astronomically unlikely,
  // but a retry costs nothing and the backend refuses duplicates either way.
  for (let attempt = 0; attempt < 10; attempt++) {
    const record = {
      key: formatKey(generateRawKey()),
      note: String(note || '').slice(0, 200),
      status: 'unused', // unused | active | revoked
      isAdmin: !!isAdmin,
      createdAt: new Date().toISOString(),
      // How long the key lasts once it's used. The clock starts when it is
      // first activated (claimDevice sets expiresAt from this), so a key
      // that sits unused for a week still gives its owner the full time.
      durationMinutes,
      expiresAt: null,
      lockedDeviceId: null,
      lockedFingerprint: null,
      currentSessionId: null,
      activatedAt: null,
      lastSeenAt: null,
      lastSeenDeviceId: null,
      blockedAttempts: 0,
      lastBlockedAt: null,
    };
    const saved = await backend.insertKey(record);
    if (saved) return saved;
  }
  throw new Error('Could not generate a unique key.');
}

const listKeys = () => backend.listKeys();
const findKey = (key) => backend.findKey(key);
const updateKey = (key, patch) => backend.updateKey(key, patch);
const deleteKey = (key) => backend.deleteKey(key);

function revokeKey(key) {
  return updateKey(key, { status: 'revoked' });
}

function unlockKey(key) {
  // Clears the browser lock, the hardware lock and any session, so the key
  // can be activated fresh - e.g. the buyer got a new PC or cleared cookies.
  // Status stays 'active'. The blocked-attempts count is kept as history.
  return updateKey(key, { lockedDeviceId: null, lockedFingerprint: null, currentSessionId: null });
}

const MESSAGES = {
  not_found: 'That key was not recognized.',
  revoked: 'This key has been revoked.',
  expired: 'This key has expired.',
  device_mismatch:
    "This key is locked to a different browser. If you've moved to a new browser or PC, ask whoever issued your key to reset it.",
  hardware_mismatch:
    "This key is locked to a different PC. If you've changed PCs or graphics cards, ask whoever issued your key to reset it.",
  signed_out: 'This session has ended - your key was signed in somewhere else, or reset. Enter it again to continue.',
};
const fail = (code) => ({ ok: false, code, message: MESSAGES[code] });

/** Why a key can't be used at all right now, or null if it's usable. */
function unusableReason(record) {
  if (!record) return 'not_found';
  if (record.status === 'revoked') return 'revoked';
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) return 'expired';
  return null;
}

/** Counts an attempt to use a key from a browser or PC it isn't locked to -
 * the main sign of a key being shared. Shown in the admin panel. */
async function noteBlocked(record) {
  await updateKey(record.key, {
    blockedAttempts: (record.blockedAttempts || 0) + 1,
    lastBlockedAt: new Date().toISOString(),
  });
}

/**
 * Checks this browser (its device cookie) and machine (its hardware
 * fingerprint) against a key that's already locked. Returns { ok: true, lock }
 * with the hardware lock to save, or a failure - which is counted as a
 * blocked attempt.
 */
async function checkLocks(record, deviceId, fp) {
  if (record.lockedDeviceId !== deviceId) {
    await noteBlocked(record);
    return fail('device_mismatch');
  }
  const hw = fingerprint.check(record.lockedFingerprint, fp, { sameBrowser: true });
  if (!hw.ok) {
    await noteBlocked(record);
    return fail('hardware_mismatch');
  }
  return { ok: true, lock: hw.lock };
}

/**
 * Activates a key for the requesting browser and machine. The first
 * activation locks the key to both; after that only the same browser on the
 * same hardware can activate it. Every activation starts a new session and
 * ends the previous one, so a key is only ever signed in in one place.
 * `rawFp` is the hardware fingerprint the browser sent.
 * Returns { ok: true, record, sessionId } or { ok: false, code, message }.
 */
async function tryActivate(key, deviceId, rawFp) {
  const fp = fingerprint.fromClient(rawFp);
  let record = await findKey(key);
  const reason = unusableReason(record);
  if (reason) return fail(reason);

  const now = new Date().toISOString();
  const sessionId = newSessionId();

  if (!record.lockedDeviceId) {
    const lock = fingerprint.check(null, fp, { sameBrowser: true }).lock;
    const claimed = await backend.claimDevice(key, { deviceId, lock, sessionId, nowIso: now });
    if (claimed) return { ok: true, record: claimed, sessionId };
    // Someone else locked it (or it was revoked) between reading and
    // claiming - re-read and fall through to the normal checks below.
    record = await findKey(key);
    const again = unusableReason(record);
    if (again) return fail(again);
  }

  const locks = await checkLocks(record, deviceId, fp);
  if (!locks.ok) return locks;

  const updated = await updateKey(key, {
    lastSeenAt: now,
    lastSeenDeviceId: deviceId,
    lockedFingerprint: locks.lock,
    currentSessionId: sessionId,
  });
  return { ok: true, record: updated, sessionId };
}

/**
 * Checks an existing session. `rawFp` is the hardware fingerprint when the
 * browser sent one (the regular check-in), or omitted for requests that
 * can't carry it (loading the app's files) - those rely on the session and
 * browser cookie, since a session only ever exists after a full check.
 * Returns { ok: true, record } or { ok: false, code, message }.
 */
async function checkSession(key, sessionId, deviceId, rawFp) {
  const record = await findKey(key);
  const reason = unusableReason(record);
  if (reason) return fail(reason);
  if (!sessionId || record.currentSessionId !== sessionId) return fail('signed_out');
  if (rawFp === undefined) {
    return record.lockedDeviceId === deviceId ? { ok: true, record } : fail('device_mismatch');
  }

  const locks = await checkLocks(record, deviceId, fingerprint.fromClient(rawFp));
  if (!locks.ok) return locks;
  const updated = await updateKey(record.key, {
    lastSeenAt: new Date().toISOString(),
    lastSeenDeviceId: deviceId,
    lockedFingerprint: locks.lock,
  });
  return { ok: true, record: updated };
}

module.exports = {
  backendName: backend.name,
  PLANS,
  isPlan,
  init,
  close: () => backend.close(),
  createKey,
  listKeys,
  findKey,
  updateKey,
  revokeKey,
  deleteKey,
  unlockKey,
  tryActivate,
  checkSession,
};

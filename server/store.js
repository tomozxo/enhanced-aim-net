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

const backend = process.env.DATABASE_URL ? require('./store-pg') : require('./store-file');

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

async function createKey({ note = '', expiresInDays = null, isAdmin = false } = {}) {
  // A clash between two random 16-character keys is astronomically unlikely,
  // but a retry costs nothing and the backend refuses duplicates either way.
  for (let attempt = 0; attempt < 10; attempt++) {
    const record = {
      key: formatKey(generateRawKey()),
      note: String(note || '').slice(0, 200),
      status: 'unused', // unused | active | revoked
      isAdmin: !!isAdmin,
      createdAt: new Date().toISOString(),
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null,
      lockedDeviceId: null,
      activatedAt: null,
      lastSeenAt: null,
      lastSeenDeviceId: null,
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
  // Clears the device lock so the key can be activated on a new
  // browser/device, e.g. the buyer cleared cookies or got a new PC. Status
  // stays 'active'.
  return updateKey(key, { lockedDeviceId: null });
}

/**
 * Attempt to activate/verify a key against the requesting device (a
 * long-lived cookie identifying "this browser" - see server/cookies.js).
 * Returns { ok: true, record } or { ok: false, code, message }.
 */
async function tryActivate(key, deviceId) {
  let record = await findKey(key);
  if (!record) return { ok: false, code: 'not_found', message: 'That key was not recognized.' };
  if (record.status === 'revoked') return { ok: false, code: 'revoked', message: 'This key has been revoked.' };
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
    return { ok: false, code: 'expired', message: 'This key has expired.' };
  }

  const now = new Date().toISOString();

  if (!record.lockedDeviceId) {
    const claimed = await backend.claimDevice(key, deviceId, now);
    if (claimed) return { ok: true, record: claimed };
    // Someone else locked it (or it was revoked) between reading and
    // claiming - re-read and fall through to the normal checks below.
    record = await findKey(key);
    if (!record) return { ok: false, code: 'not_found', message: 'That key was not recognized.' };
    if (record.status === 'revoked') return { ok: false, code: 'revoked', message: 'This key has been revoked.' };
  }

  if (record.lockedDeviceId !== deviceId) {
    return {
      ok: false,
      code: 'device_mismatch',
      message:
        'This key is already activated on a different browser/device. Ask the seller to reset it if you need to move it.',
    };
  }

  const updated = await updateKey(key, { lastSeenAt: now, lastSeenDeviceId: deviceId });
  return { ok: true, record: updated };
}

module.exports = {
  backendName: backend.name,
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
};

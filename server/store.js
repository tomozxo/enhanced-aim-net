// Minimal JSON-file license key store. No native dependencies (works anywhere
// Node runs, no build tools needed on Windows). Fine for the scale a single
// seller needs; writes are synchronous so requests can't interleave and
// corrupt the file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'keys.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ keys: [] }, null, 2));
}

function readAll() {
  ensureStore();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { keys: [] };
  }
}

function writeAll(db) {
  // Write to a temp file then rename, so a crash mid-write can't leave
  // keys.json truncated/corrupt.
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function formatKey(raw) {
  // raw: 16 uppercase hex-ish base32 chars -> R6S-XXXX-XXXX-XXXX-XXXX
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

function createKey({ note = '', expiresInDays = null, isAdmin = false } = {}) {
  const db = readAll();
  let key;
  do {
    key = formatKey(generateRawKey());
  } while (db.keys.some((k) => k.key === key));

  const now = new Date().toISOString();
  const record = {
    key,
    note: String(note || '').slice(0, 200),
    status: 'unused', // unused | active | revoked
    isAdmin: !!isAdmin,
    createdAt: now,
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null,
    lockedDeviceId: null,
    activatedAt: null,
    lastSeenAt: null,
    lastSeenDeviceId: null,
  };
  db.keys.push(record);
  writeAll(db);
  return record;
}

function listKeys() {
  return readAll().keys;
}

function findKey(key) {
  return readAll().keys.find((k) => k.key === key) || null;
}

function updateKey(key, patch) {
  const db = readAll();
  const idx = db.keys.findIndex((k) => k.key === key);
  if (idx === -1) return null;
  db.keys[idx] = { ...db.keys[idx], ...patch };
  writeAll(db);
  return db.keys[idx];
}

function revokeKey(key) {
  return updateKey(key, { status: 'revoked' });
}

function deleteKey(key) {
  const db = readAll();
  const before = db.keys.length;
  db.keys = db.keys.filter((k) => k.key !== key);
  writeAll(db);
  return db.keys.length < before;
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
function tryActivate(key, deviceId) {
  const record = findKey(key);
  if (!record) return { ok: false, code: 'not_found', message: 'That key was not recognized.' };
  if (record.status === 'revoked') return { ok: false, code: 'revoked', message: 'This key has been revoked.' };
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
    return { ok: false, code: 'expired', message: 'This key has expired.' };
  }

  const now = new Date().toISOString();

  if (!record.lockedDeviceId) {
    const updated = updateKey(key, {
      status: 'active',
      lockedDeviceId: deviceId,
      activatedAt: record.activatedAt || now,
      lastSeenAt: now,
      lastSeenDeviceId: deviceId,
    });
    return { ok: true, record: updated };
  }

  if (record.lockedDeviceId !== deviceId) {
    return {
      ok: false,
      code: 'device_mismatch',
      message:
        'This key is already activated on a different browser/device. Ask the seller to reset it if you need to move it.',
    };
  }

  const updated = updateKey(key, { lastSeenAt: now, lastSeenDeviceId: deviceId });
  return { ok: true, record: updated };
}

module.exports = {
  createKey,
  listKeys,
  findKey,
  updateKey,
  revokeKey,
  deleteKey,
  unlockKey,
  tryActivate,
};

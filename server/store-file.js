// JSON-file backend for the key store (see store.js). Used when no
// DATABASE_URL is set - handy for running locally. On Render's free plan the
// file lives on a temporary disk and is thrown away on every deploy, restart
// and sleep, which is why production uses the Postgres backend instead.
//
// Writes are synchronous so two requests can't interleave and corrupt the
// file; the functions are async only to match the Postgres backend.

const fs = require('fs');
const path = require('path');

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

module.exports = {
  name: 'local file (data/keys.json) - keys are lost whenever the host wipes its disk',

  async init() {
    ensureStore();
  },

  /** Adds a new record, or returns null if that key already exists. */
  async insertKey(record) {
    const db = readAll();
    if (db.keys.some((k) => k.key === record.key)) return null;
    db.keys.push(record);
    writeAll(db);
    return record;
  },

  async listKeys() {
    return readAll().keys;
  },

  async findKey(key) {
    return readAll().keys.find((k) => k.key === key) || null;
  },

  async updateKey(key, patch) {
    const db = readAll();
    const idx = db.keys.findIndex((k) => k.key === key);
    if (idx === -1) return null;
    db.keys[idx] = { ...db.keys[idx], ...patch };
    writeAll(db);
    return db.keys[idx];
  },

  async deleteKey(key) {
    const db = readAll();
    const before = db.keys.length;
    db.keys = db.keys.filter((k) => k.key !== key);
    writeAll(db);
    return db.keys.length < before;
  },

  /** Locks an unlocked, non-revoked key to this device. Returns the updated
   * record, or null if it was already locked (or revoked) by the time we got
   * here. */
  async claimDevice(key, deviceId, nowIso) {
    const db = readAll();
    const idx = db.keys.findIndex((k) => k.key === key);
    if (idx === -1) return null;
    const rec = db.keys[idx];
    if (rec.lockedDeviceId || rec.status === 'revoked') return null;
    db.keys[idx] = {
      ...rec,
      status: 'active',
      lockedDeviceId: deviceId,
      activatedAt: rec.activatedAt || nowIso,
      lastSeenAt: nowIso,
      lastSeenDeviceId: deviceId,
    };
    writeAll(db);
    return db.keys[idx];
  },

  async close() {},
};

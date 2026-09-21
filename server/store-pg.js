// Postgres backend for the key store (see store.js), used whenever
// DATABASE_URL is set. Works with Supabase or any other Postgres. The keys
// live in the database rather than on the web server's disk, so deploys,
// restarts and Render's free-tier sleep don't touch them.

const { Pool } = require('pg');

// Our field names <-> the table's column names. Anything not listed here
// can't be written, so a stray field can never turn into bad SQL.
const COLUMNS = {
  key: 'key',
  note: 'note',
  status: 'status',
  isAdmin: 'is_admin',
  createdAt: 'created_at',
  expiresAt: 'expires_at',
  lockedDeviceId: 'locked_device_id',
  activatedAt: 'activated_at',
  lastSeenAt: 'last_seen_at',
  lastSeenDeviceId: 'last_seen_device_id',
};

/** Hosted databases like Supabase only accept encrypted connections; a
 * Postgres on this machine usually doesn't offer encryption at all. The
 * certificate isn't pinned (rejectUnauthorized: false), which is the usual
 * setup for Supabase from Node - the connection is still encrypted. */
function sslFor(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  } catch {
    /* unparseable URL - let pg report it properly below */
  }
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslFor(process.env.DATABASE_URL),
  // A handful of connections is plenty for license checks, and stays well
  // inside the connection limit of Supabase's free plan.
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// A dropped idle connection (the database restarting, a network blip) is
// reported here rather than crashing the process; the pool just opens a
// fresh one on the next query.
pool.on('error', (err) => {
  console.error('[store] idle database connection dropped:', err.message);
});

const iso = (v) => (v == null ? null : new Date(v).toISOString());

/** A table row -> the same record shape the file backend and the admin
 * panel use (camelCase, ISO date strings). */
function fromRow(r) {
  if (!r) return null;
  return {
    key: r.key,
    note: r.note,
    status: r.status,
    isAdmin: r.is_admin,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    lockedDeviceId: r.locked_device_id,
    activatedAt: iso(r.activated_at),
    lastSeenAt: iso(r.last_seen_at),
    lastSeenDeviceId: r.last_seen_device_id,
  };
}

module.exports = {
  name: 'Postgres (DATABASE_URL) - keys survive deploys and restarts',

  /** Creates the table the first time, and is a no-op after that. Row Level
   * Security is switched on with no policies, which blocks Supabase's
   * public REST API from reading or writing keys - only this server, which
   * connects as the table's owner, can. */
  async init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS license_keys (
        key                 TEXT PRIMARY KEY,
        note                TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'unused',
        is_admin            BOOLEAN NOT NULL DEFAULT FALSE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at          TIMESTAMPTZ,
        locked_device_id    TEXT,
        activated_at        TIMESTAMPTZ,
        last_seen_at        TIMESTAMPTZ,
        last_seen_device_id TEXT
      )`);
    await pool.query('ALTER TABLE license_keys ENABLE ROW LEVEL SECURITY');
  },

  /** Adds a new record, or returns null if that key already exists. */
  async insertKey(r) {
    const { rows } = await pool.query(
      `INSERT INTO license_keys (key, note, status, is_admin, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO NOTHING
       RETURNING *`,
      [r.key, r.note, r.status, r.isAdmin, r.createdAt, r.expiresAt]
    );
    return fromRow(rows[0]);
  },

  async listKeys() {
    const { rows } = await pool.query('SELECT * FROM license_keys ORDER BY created_at, key');
    return rows.map(fromRow);
  },

  async findKey(key) {
    const { rows } = await pool.query('SELECT * FROM license_keys WHERE key = $1', [key]);
    return fromRow(rows[0]);
  },

  async updateKey(key, patch) {
    const fields = Object.keys(patch).filter((f) => f !== 'key' && COLUMNS[f]);
    if (!fields.length) return this.findKey(key);
    const sets = fields.map((f, i) => `${COLUMNS[f]} = $${i + 2}`).join(', ');
    const { rows } = await pool.query(`UPDATE license_keys SET ${sets} WHERE key = $1 RETURNING *`, [
      key,
      ...fields.map((f) => patch[f]),
    ]);
    return fromRow(rows[0]);
  },

  async deleteKey(key) {
    const { rowCount } = await pool.query('DELETE FROM license_keys WHERE key = $1', [key]);
    return rowCount > 0;
  },

  /** Locks an unlocked, non-revoked key to this device in a single
   * statement, so two browsers activating the same fresh key at the same
   * moment can't both win - the second one's WHERE no longer matches.
   * Returns the updated record, or null if it was already taken. */
  async claimDevice(key, deviceId, nowIso) {
    const { rows } = await pool.query(
      `UPDATE license_keys
          SET status = 'active',
              locked_device_id = $2,
              activated_at = COALESCE(activated_at, $3::timestamptz),
              last_seen_at = $3::timestamptz,
              last_seen_device_id = $2
        WHERE key = $1 AND locked_device_id IS NULL AND status <> 'revoked'
        RETURNING *`,
      [key, deviceId, nowIso]
    );
    return fromRow(rows[0]);
  },

  async close() {
    await pool.end();
  },
};

// Managed Postgres (Supabase) via node-postgres. Replaces the previous local
// node:sqlite file. The whole data layer is ASYNC now.
//
// Integrity: SQLite gave us single-writer serialization for free. Postgres does
// not, so ballot casts (and other chain-extending writes) run inside tx(fn,
// {lock:true}), which takes a transaction-scoped advisory lock. That serializes
// every chain write cluster-wide — even across multiple instances — so the
// hash chain can never fork under concurrency.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires TLS; it uses a managed cert chain we don't pin here.
  ssl: /supabase|amazonaws|render/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX) || 10,
});

// Advisory-lock key for the ballot/chain critical section. Any constant works;
// it only needs to be the SAME everywhere that extends the chain.
const CHAIN_LOCK = 4242;

async function query(text, params) { return (await pool.query(text, params)).rows; }
async function one(text, params) { return (await query(text, params))[0] || null; }
async function run(text, params) { return pool.query(text, params); } // -> { rowCount, rows }

// Write transaction. Pass { lock: true } for any write that reads-then-extends
// the hash chain so concurrent casters serialize. fn gets a pg client whose
// .query(text, params) -> { rows, rowCount }.
async function tx(fn, { lock = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (lock) await client.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

const DDL = `
-- An election has many positions (offices). Each position has its own
-- candidates, its own ballot per voter, its own "not interested" option.
CREATE TABLE IF NOT EXISTS position (
  position_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS candidate (
  candidate_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position_id  INTEGER REFERENCES position(position_id),
  name         TEXT NOT NULL,
  description  TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  photo        TEXT
);
CREATE TABLE IF NOT EXISTS roster (
  student_id   TEXT PRIMARY KEY,
  name         TEXT,
  email        TEXT,
  checked_in   INTEGER NOT NULL DEFAULT 0,
  token_used   INTEGER NOT NULL DEFAULT 0,
  token_hash   TEXT,
  otp_hash     TEXT,
  otp_expires  BIGINT,
  otp_attempts INTEGER NOT NULL DEFAULT 0
);
-- A ballot is one voter's choice for ONE position. candidate_id NULL = the
-- "not interested" (none-of-the-above) option. No voter identity ever lands here.
CREATE TABLE IF NOT EXISTS ballot (
  ballot_id    TEXT PRIMARY KEY,
  position_id  INTEGER NOT NULL REFERENCES position(position_id),
  candidate_id INTEGER REFERENCES candidate(candidate_id),
  signature    TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);
-- Admin accounts: username + scrypt password hash (stdlib, no bcrypt dep).
CREATE TABLE IF NOT EXISTS admin_user (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- Monotonic insertion order for the chain walk (Postgres has no rowid).
ALTER TABLE ballot ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;
INSERT INTO meta(key, value) VALUES ('status', 'open')      ON CONFLICT (key) DO NOTHING;
INSERT INTO meta(key, value) VALUES ('chain_tip', 'GENESIS') ON CONFLICT (key) DO NOTHING;
`;

// Create tables if absent. Call once at startup before serving.
async function init() { await pool.query(DDL); }

module.exports = { pool, query, one, run, tx, init, CHAIN_LOCK, DDL };

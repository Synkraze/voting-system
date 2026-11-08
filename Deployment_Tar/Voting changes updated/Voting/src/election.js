const db = require('./db');
const { randomUUID } = require('node:crypto');
const { verifyChain } = require('./verify');

// Read a single meta value (undefined if absent).
async function value(key) {
  const r = await db.one('SELECT value FROM meta WHERE key = $1', [key]);
  return r ? r.value : undefined;
}
// Upsert a meta value on a given transaction client.
const setMeta = (c, key, val) =>
  c.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, val]);

// Ensure an election_id exists (was a module-load side effect under SQLite).
async function initElection() {
  await db.run('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['election_id', randomUUID()]);
}

async function closeElection() {
  await db.tx(async (c) => {
    const status = (await c.query("SELECT value FROM meta WHERE key = 'status'")).rows[0];
    if (!status || status.value !== 'closed') {
      // Pin the expected tip, not a possibly damaged chain's partial result.
      const tip = (await c.query("SELECT value FROM meta WHERE key = 'chain_tip'")).rows[0];
      await setMeta(c, 'root', tip.value);
      await setMeta(c, 'status', 'closed');
      await c.query('UPDATE roster SET token_hash = NULL, otp_hash = NULL, otp_expires = NULL');
    }
  }, { lock: true });
  return verifyChain();
}

async function syncDeadline() {
  const [status, closeAt] = await Promise.all([value('status'), value('close_at')]);
  const deadline = Number(closeAt);
  if ((status === 'open' || status === 'held') && deadline && Date.now() >= deadline) await closeElection();
}

async function changeVotingStatus(from, to) {
  return db.tx(async (c) => {
    const current = (await c.query("SELECT value FROM meta WHERE key = 'status'")).rows[0]?.value;
    if (current !== from) return false;
    const closeAt = (await c.query("SELECT value FROM meta WHERE key = 'close_at'")).rows[0]?.value;
    if (to === 'open' && closeAt && Date.now() >= Number(closeAt)) return false;
    await setMeta(c, 'status', to);
    return true;
  }, { lock: true });
}

async function resetElection(mode) {
  await db.tx(async (c) => {
    await c.query('DELETE FROM ballot');
    await c.query('UPDATE roster SET checked_in = 0, token_used = 0, token_hash = NULL, otp_hash = NULL, otp_expires = NULL, otp_attempts = 0');
    await c.query("DELETE FROM meta WHERE key IN ('root','approved_by','approved_at','approval_sig','close_at')");
    if (mode === 'new') {
      // candidate references position, so drop candidates first.
      await c.query('DELETE FROM candidate');
      await c.query('DELETE FROM position');
      // Clean slate: restart IDs at 1 (SQLite reused rowids; Postgres identity
      // keeps climbing unless told otherwise). Safe here — all ballots
      // referencing old IDs were just deleted and the chain reset to GENESIS.
      await c.query('ALTER TABLE candidate ALTER COLUMN candidate_id RESTART WITH 1');
      await c.query('ALTER TABLE position ALTER COLUMN position_id RESTART WITH 1');
      await c.query('DELETE FROM roster');
      await c.query("DELETE FROM meta WHERE key IN ('title','description')");
    }
    await setMeta(c, 'chain_tip', 'GENESIS');
    await setMeta(c, 'status', 'open');
    await setMeta(c, 'election_id', randomUUID());
  });
}

module.exports = { value, closeElection, syncDeadline, resetElection, initElection, changeVotingStatus };

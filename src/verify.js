// Independent, read-only re-verification. Recompute the chain and check every
// ed25519 signature against the pinned public key. Anyone can run GET /verify;
// there is no identity to leak.
const db = require('./db');
const { chainHash, verify, publicKeyPem } = require('./crypto');

async function verifyChain() {
  const pub = await publicKeyPem(db);
  // seq is a monotonic identity column -> true insertion order.
  const ballots = await db.query(
    'SELECT ballot_id, position_id, candidate_id, signature, prev_hash, hash, created_at, voided FROM ballot ORDER BY seq ASC'
  );
  let prev = 'GENESIS';

  for (const b of ballots) {
    if (b.prev_hash !== prev) {
      return { ok: false, count: ballots.length, root: prev, firstBad: b.ballot_id, reason: 'broken_chain' };
    }
    const expected = chainHash(b);
    if (expected !== b.hash) {
      return { ok: false, count: ballots.length, root: prev, firstBad: b.ballot_id, reason: 'bad_hash' };
    }
    if (!verify(b.hash, b.signature, pub)) {
      return { ok: false, count: ballots.length, root: prev, firstBad: b.ballot_id, reason: 'bad_signature' };
    }
    prev = b.hash;
  }

  const tip = await db.one("SELECT value FROM meta WHERE key = 'chain_tip'");
  if (tip?.value !== prev) {
    return { ok: false, count: ballots.length, root: prev, firstBad: null, reason: 'tip_mismatch' };
  }
  const status = await db.one("SELECT value FROM meta WHERE key = 'status'");
  const root = await db.one("SELECT value FROM meta WHERE key = 'root'");
  if (status?.value === 'closed' && root?.value !== prev) {
    return { ok: false, count: ballots.length, root: prev, firstBad: null, reason: 'root_mismatch' };
  }
  return { ok: true, count: ballots.length, voided: ballots.reduce((n, b) => n + (b.voided ? 1 : 0), 0), root: prev, firstBad: null };
}

module.exports = { verifyChain };

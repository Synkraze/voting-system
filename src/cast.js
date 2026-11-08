// The serialized write path. One locked transaction per voter: burn the vote
// session token, then insert ONE choice per eligible position and extend the hash chain.
//
// A voter's per-position ballots are consecutive in the chain. The student_id
// column also links them to the voter for the admin ballot search and void flow.
const db = require('./db');
const { sha256, chainHash, sign, ballotId } = require('./crypto');
const { positionAllowsLevel } = require('./eligibility');

async function castBallot(rawToken, selections, now) {
  return db.tx(async (c) => {
    const status = (await c.query("SELECT value FROM meta WHERE key = 'status'")).rows[0];
    if (status?.value === 'held') throw Object.assign(new Error('Voting is on hold. You can submit this ballot after the admin resumes voting.'), { code: 'HELD' });
    if (!status || status.value !== 'open') throw Object.assign(new Error('Voting is closed'), { code: 'CLOSED' });
    // Hard deadline: once the scheduled end passes, no ballot is accepted even
    // before an admin manually closes.
    const closeAt = (await c.query("SELECT value FROM meta WHERE key = 'close_at'")).rows[0];
    if (closeAt && closeAt.value && now >= Number(closeAt.value)) {
      throw Object.assign(new Error('The voting period has ended'), { code: 'CLOSED' });
    }
    const voter = (await c.query('SELECT student_id, level FROM roster WHERE token_hash = $1 AND checked_in = 1 AND token_used = 0', [sha256(rawToken)])).rows[0];
    // One message for bad/duplicate/already-used session -> no information leak.
    if (!voter) throw Object.assign(new Error('Invalid or already-used session'), { code: 'BADTOKEN' });

    // Only the positions this voter's level is eligible for (NULL elig_levels = open to all).
    const allPositions = (await c.query('SELECT position_id, elig_levels FROM position ORDER BY position_id')).rows;
    const positions = allPositions.filter((p) => positionAllowsLevel(p.elig_levels, voter.level));
    if (!positions.length) throw Object.assign(new Error('There is nothing for you to vote on'), { code: 'NOPOSITIONS' });
    const eligibleIds = new Set(positions.map((p) => p.position_id));

    // Every eligible position receives a ballot. Unselected positions count as
    // "not interested"; explicit null has the same meaning for API clients.
    const chosen = new Map();
    if (!Array.isArray(selections)) throw Object.assign(new Error('Selections must be a list'), { code: 'BADSELECTIONS' });
    for (const s of selections) {
      const pid = Number(s && s.position_id);
      const raw = s && s.candidate_id;
      if (!eligibleIds.has(pid)) throw Object.assign(new Error('That position is not on your ballot'), { code: 'INELIGIBLE' });
      if (chosen.has(pid)) throw Object.assign(new Error('Choose only once per position'), { code: 'DUPLICATE' });
      if (raw === '' || raw === undefined) throw Object.assign(new Error('Choose a candidate or omit the position'), { code: 'BADCANDIDATE' });
      chosen.set(pid, raw === null ? null : Number(raw));
    }
    if (chosen.size === 0) throw Object.assign(new Error('Select at least one position before submitting'), { code: 'EMPTY' });
    // Validate all selected candidates before consuming the one-time token.
    const toCast = [];
    for (const { position_id } of positions) {
      const candidate_id = chosen.get(position_id) ?? null;
      if (candidate_id === null) { toCast.push({ position_id, candidate_id }); continue; }
      const ok = (await c.query('SELECT 1 FROM candidate WHERE candidate_id = $1 AND position_id = $2 AND active = 1', [candidate_id, position_id])).rows[0];
      if (!ok) throw Object.assign(new Error('Choose an active candidate from this position'), { code: 'BADCANDIDATE' });
      toCast.push({ position_id, candidate_id });
    }

    await c.query('UPDATE roster SET token_used = 1, token_hash = NULL WHERE student_id = $1', [voter.student_id]);

    let prev = (await c.query("SELECT value FROM meta WHERE key = 'chain_tip'")).rows[0].value;
    for (const sel of toCast) {
      const b = { ballot_id: ballotId(), position_id: sel.position_id, candidate_id: sel.candidate_id, created_at: now, prev_hash: prev };
      b.hash = chainHash(b);
      b.signature = sign(b.hash);
      await c.query(
        'INSERT INTO ballot (ballot_id, position_id, candidate_id, signature, prev_hash, hash, created_at, student_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [b.ballot_id, b.position_id, b.candidate_id, b.signature, b.prev_hash, b.hash, b.created_at, voter.student_id]
      );
      prev = b.hash;
    }
    await c.query("UPDATE meta SET value = $1 WHERE key = 'chain_tip'", [prev]);
    return { ballots: toCast.length, tip: prev };
  }, { lock: true });
}

module.exports = { castBallot };

// The serialized write path. One locked transaction per voter: burn the vote
// session token, then insert ONE ballot per position (candidate_id null = the
// "not interested" option) and extend the hash chain across all of them. NO
// student_id, NO token_hash ever touches a ballot.
//
// ponytail: a voter's per-position ballots are consecutive in the chain, so an
// auditor can see "this anonymous ballot-set chose X,Y,Z" — never WHO. Acceptable
// for a campus election (a paper ballot reveals the same bundle). Shuffle across
// voters if cross-position unlinkability is ever required.
const db = require('./db');
const { sha256, chainHash, sign, ballotId } = require('./crypto');

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
    const voter = (await c.query('SELECT student_id FROM roster WHERE token_hash = $1 AND checked_in = 1 AND token_used = 0', [sha256(rawToken)])).rows[0];
    // One message for bad/duplicate/already-used session -> no information leak.
    if (!voter) throw Object.assign(new Error('Invalid or already-used session'), { code: 'BADTOKEN' });

    const positions = (await c.query('SELECT position_id FROM position ORDER BY position_id')).rows;
    if (!positions.length) throw Object.assign(new Error('There is nothing to vote on yet'), { code: 'NOPOSITIONS' });

    // Index the submitted choices by position; '' / null / missing -> not interested.
    const chosen = new Map();
    for (const s of Array.isArray(selections) ? selections : []) {
      const pid = Number(s && s.position_id);
      const raw = s && s.candidate_id;
      chosen.set(pid, raw == null || raw === '' ? null : Number(raw));
    }
    // Exactly one valid selection per position (not interested counts).
    const toCast = [];
    for (const { position_id } of positions) {
      if (!chosen.has(position_id)) throw Object.assign(new Error('Make a selection for every position'), { code: 'INCOMPLETE' });
      const candidate_id = chosen.get(position_id);
      if (candidate_id != null) {
        const ok = (await c.query('SELECT 1 FROM candidate WHERE candidate_id = $1 AND position_id = $2 AND active = 1', [candidate_id, position_id])).rows[0];
        if (!ok) throw Object.assign(new Error('Unknown candidate'), { code: 'BADCANDIDATE' });
      }
      toCast.push({ position_id, candidate_id });
    }

    await c.query('UPDATE roster SET token_used = 1, token_hash = NULL WHERE student_id = $1', [voter.student_id]);

    let prev = (await c.query("SELECT value FROM meta WHERE key = 'chain_tip'")).rows[0].value;
    for (const sel of toCast) {
      const b = { ballot_id: ballotId(), position_id: sel.position_id, candidate_id: sel.candidate_id, created_at: now, prev_hash: prev };
      b.hash = chainHash(b);
      b.signature = sign(b.hash);
      await c.query(
        'INSERT INTO ballot (ballot_id, position_id, candidate_id, signature, prev_hash, hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [b.ballot_id, b.position_id, b.candidate_id, b.signature, b.prev_hash, b.hash, b.created_at]
      );
      prev = b.hash;
    }
    await c.query("UPDATE meta SET value = $1 WHERE key = 'chain_tip'", [prev]);
    return { ballots: toCast.length, tip: prev };
  }, { lock: true });
}

module.exports = { castBallot };

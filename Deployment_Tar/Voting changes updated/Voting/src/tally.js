// Counting, per position. Explicit per-position status so the UI never guesses a
// winner. A ballot with candidate_id NULL is a "not interested" vote and is
// counted toward the position total (and the majority test).
const db = require('./db');

// ::int so Postgres COUNT (bigint) comes back as a JS number, not a string.
const CANDIDATE_COUNTS = `
  SELECT c.candidate_id, c.position_id, c.name, c.description, c.photo, c.active,
         COUNT(b.ballot_id)::int AS votes
  FROM candidate c
  LEFT JOIN ballot b ON b.candidate_id = c.candidate_id
  GROUP BY c.candidate_id
`;

// Decide a single position's outcome from its candidate rows and NOTA count.
function decide(results, notInterested, total) {
  const active = results.filter((c) => c.active);
  if (!total) return { status: 'no_votes', winner: null };

  // Single-candidate race: majority rule. The sole candidate must clear >50% of
  // all votes cast for the position (their votes vs "not interested").
  if (active.length === 1) {
    const c = active[0];
    const passed = c.votes * 2 > total;
    return {
      status: passed ? 'majority_pass' : 'majority_fail',
      winner: passed ? c : null,
      majority: { required: true, threshold: 50, pct: Math.round((c.votes / total) * 1000) / 10, passed },
    };
  }

  // Multi-candidate race: plurality. "Not interested" is reported and, if it
  // outpolls every candidate, flags a re-run — but is never itself a winner.
  const top = active[0] ? active[0].votes : 0;
  if (top === 0) return { status: 'no_votes', winner: null };
  if (notInterested > top) return { status: 'nota_plurality', winner: null, majority: { required: false } };
  const leaders = active.filter((c) => c.votes === top);
  if (leaders.length > 1) return { status: 'tie', tied: leaders, winner: null, majority: { required: false } };
  return { status: 'winner', winner: active[0], majority: { required: false } };
}

async function tally() {
  const positions = await db.query('SELECT position_id, title, seq FROM position ORDER BY seq, position_id');
  const candidates = await db.query(CANDIDATE_COUNTS);
  const notaRows = await db.query('SELECT position_id, COUNT(*)::int AS votes FROM ballot WHERE candidate_id IS NULL GROUP BY position_id');
  const nota = Object.fromEntries(notaRows.map((r) => [r.position_id, r.votes]));

  const out = positions.map((p) => {
    const results = candidates
      .filter((c) => c.position_id === p.position_id)
      .sort((a, b) => b.votes - a.votes || a.candidate_id - b.candidate_id);
    const notInterested = nota[p.position_id] || 0;
    const total = results.reduce((s, c) => s + c.votes, 0) + notInterested;
    return { position_id: p.position_id, title: p.title, seq: p.seq, results, not_interested: notInterested, total, ...decide(results, notInterested, total) };
  });

  const total = out.reduce((s, p) => s + p.total, 0);
  // Approval blockers: no votes anywhere, or any unresolved tie.
  const hasTie = out.some((p) => p.status === 'tie');
  return { positions: out, total, hasTie };
}

module.exports = { tally };

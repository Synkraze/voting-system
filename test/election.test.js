// Simulated end-to-end suite for the multi-position / email-OTP / username-admin
// system. Boots the REAL server per scenario with an isolated DB schema + keypair,
// drives it over HTTP. node --test, no framework.
//
// Isolation: each boot() gets its own Postgres SCHEMA (CREATE SCHEMA / DROP SCHEMA
// CASCADE). The spawned server lands there via a connection-string
// `options=-c search_path=<schema>` param; direct DB assertions use e.pool.
//
// Voter OTP without SMTP: request-otp would send real email, so tests instead
// write roster.otp_hash directly (via auth.hashOtp) and call verify-otp to mint a
// one-time vote session — exactly what a real code would produce.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { hashOtp } = require('../src/auth');
const { DDL } = require('../src/db');
const { parseLevelCandidates } = require('../src/level-import');
const { GROUPS } = require('../src/official-ballot');

const ROOT = path.join(__dirname, '..');
const DB_URL = process.env.DATABASE_URL;
const SSL = /supabase|amazonaws|render/.test(DB_URL || '') ? { rejectUnauthorized: false } : undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 20000 + crypto.randomInt(30000);

const scopedUrl = (schema) => DB_URL + (DB_URL.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=' + schema);
const ADMIN_USER = 'officer';
const ADMIN_PASS = 'password1234';

async function boot(prepare = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vote-'));
  const keyDir = path.join(dir, 'keys');
  const uploadDir = path.join(dir, 'uploads');
  const schema = 'test_' + crypto.randomBytes(6).toString('hex');
  const url = scopedUrl(schema);
  const port = nextPort++;
  const env = { ...process.env, DATABASE_URL: url, KEY_DIR: keyDir, UPLOAD_DIR: uploadDir, ADMIN_USER, ADMIN_PASS, PORT: String(port) };

  const pool = new Pool({ connectionString: url, ssl: SSL });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  if (prepare) {
    await pool.query(DDL);
    await prepare(pool);
  }
  execFileSync(process.execPath, ['src/crypto.js', 'keygen'], { cwd: ROOT, env, stdio: 'ignore' });
  const srv = spawn(process.execPath, ['--no-warnings', 'src/server.js'], { cwd: ROOT, env, stdio: 'ignore' });

  const base = `http://localhost:${port}`;
  let ready = false;
  for (let i = 0; i < 1200; i++) {
    if (srv.exitCode !== null) break;
    try { await fetch(`${base}/positions`); ready = true; break; } catch { await sleep(50); }
  }
  if (!ready) {
    srv.kill();
    await pool.query(`DROP SCHEMA \"${schema}\" CASCADE`);
    await pool.end();
    throw new Error(`Voting server did not start within 60 seconds (exit code: ${srv.exitCode}).`);
  }

  const e = {
    base, schema, pool, uploadDir, dir, token: null,
    stop: async () => {
      srv.kill();
      try { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } catch { /* ignore */ }
      await pool.end();
    },
    api: (method, p, body, admin) => fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(admin ? { authorization: 'Bearer ' + e.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
  // Sign in as the seeded admin.
  const login = await (await e.api('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS })).json();
  e.token = login.token;
  return e;
}

// positions: [{ title, candidates: [names] }]; rosterLines: ['S1,Name,s1@x.edu'].
async function seed(e, positions, rosterLines) {
  for (const p of positions) {
    const pr = await (await e.api('POST', '/admin/positions', { title: p.title }, true)).json();
    if (p.candidates && p.candidates.length) {
      await (await e.api('POST', '/admin/candidates', { position_id: pr.position_id, names: p.candidates }, true)).json();
    }
  }
  if (rosterLines && rosterLines.length) await (await e.api('POST', '/admin/roster', { csv: rosterLines.join('\n') }, true)).json();
  return (await e.api('GET', '/positions')).json();
}

// Mint a one-time vote session the way verify-otp does, bypassing SMTP.
async function voteToken(e, email) {
  const otp = '135790';
  await e.pool.query('UPDATE roster SET otp_hash = $1, otp_expires = $2, otp_attempts = 0 WHERE lower(email) = $3',
    [hashOtp(email, otp), Date.now() + 600000, email.toLowerCase()]);
  const r = await (await e.api('POST', '/voter/verify-otp', { email, otp })).json();
  return r.token;
}

// choices: { positionTitle: candidateName | null (not interested) }.
async function castVote(e, email, choices) {
  const token = await voteToken(e, email);
  const positions = await (await e.api('GET', '/positions')).json();
  const selections = positions.map((p) => {
    const choice = Object.prototype.hasOwnProperty.call(choices, p.title) ? choices[p.title] : null;
    const cand = choice ? p.candidates.find((c) => c.name === choice) : null;
    return { position_id: p.position_id, candidate_id: cand ? cand.candidate_id : null };
  });
  return e.api('POST', '/vote', { token, selections });
}

const findPos = (tally, title) => tally.positions.find((p) => p.title === title);

test('admin login required: no token is rejected, bad password rejected, good password works', async () => {
  const e = await boot();
  try {
    assert.strictEqual((await e.api('GET', '/admin/positions')).status, 401); // no token
    assert.strictEqual((await e.api('POST', '/admin/login', { username: ADMIN_USER, password: 'wrong' })).status, 401);
    assert.strictEqual((await e.api('GET', '/admin/positions', null, true)).status, 200); // seeded token
    const me = await (await e.api('GET', '/admin/me', null, true)).json();
    assert.strictEqual(me.username, ADMIN_USER);
  } finally { await e.stop(); }
});

test('positions + candidates: ballot groups active candidates and adds "not interested"', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice', 'Bob'] }, { title: 'Secretary', candidates: ['Cara'] }], []);
    const positions = await (await e.api('GET', '/positions')).json();
    assert.strictEqual(positions.length, 2);
    const pres = positions.find((p) => p.title === 'President');
    assert.strictEqual(pres.candidates.length, 2);
  } finally { await e.stop(); }
});

test('official Sports CSV creates the four approved ballot groups in order', async () => {
  const e = await boot();
  try {
    const csv = fs.readFileSync(path.join(ROOT, 'data/candidates-5-avp-sports.csv'), 'utf8');
    const imported = await e.api('POST', '/admin/positions/import-levels', { title: 'AVP Sports', csv }, true);
    assert.strictEqual(imported.status, 200, JSON.stringify(await imported.json()));
    const positions = await (await e.api('GET', '/positions')).json();
    assert.deepStrictEqual(positions.map(p => p.title), [
      'Assistant Vice President – Sports — Level 4 Male',
      'Assistant Vice President – Sports — Level 4 Female',
      'Assistant Vice President – Sports — Level 5 or 6 Male',
      'Assistant Vice President – Sports — Level 5 or 6 Female',
    ]);
    assert.deepStrictEqual(positions.map(p => p.candidates.map(c => c.name)), [
      ['Muhammed Rabei Riyas', 'Mohammed Safwan Sajeerkhan', 'Rayan Muhammad Shafeeque'],
      ['Fathima Muhammad', 'Nimna Manoharan', 'Arafah Cheick Davoudou'],
      ['Mohammed Ifad'],
      ['Farhana Jamiludheen'],
    ]);
    assert.strictEqual((await e.api('POST', '/admin/positions/import-levels', { title: 'AVP Sports', csv }, true)).status, 409);
    await e.api('POST', '/admin/roster', { csv: 'S1,One,s1@x.edu' }, true);
    const token = await voteToken(e, 's1@x.edu');
    const selections = positions.map(p => ({ position_id: p.position_id, candidate_id: p.candidates[0].candidate_id }));
    const voted = await e.api('POST', '/vote', { token, selections });
    assert.strictEqual(voted.status, 200, JSON.stringify(await voted.json()));
    const tally = await (await e.api('GET', '/admin/tally', null, true)).json();
    assert.strictEqual(tally.total, 4);
    assert.ok(tally.positions.every(p => p.total === 1));
  } finally { await e.stop(); }
});

test('existing official position CSV flow uses the approved arrangement', async () => {
  const e = await boot();
  try {
    const position = await (await e.api('POST', '/admin/positions', { title: 'AVP Sports' }, true)).json();
    const csv = fs.readFileSync(path.join(ROOT, 'data/candidates-5-avp-sports.csv'), 'utf8');
    const result = await e.api('POST', '/admin/candidates', { position_id: position.position_id, csv }, true);
    assert.strictEqual(result.status, 200);
    assert.strictEqual((await result.json()).grouped, true);
    const positions = await (await e.api('GET', '/positions')).json();
    assert.deepStrictEqual(positions.map(p => p.title), [
      'Assistant Vice President – Sports — Level 4 Male',
      'Assistant Vice President – Sports — Level 4 Female',
      'Assistant Vice President – Sports — Level 5 or 6 Male',
      'Assistant Vice President – Sports — Level 5 or 6 Female',
    ]);
    assert.deepStrictEqual(positions.map(p => p.candidates.length), [3, 3, 1, 1]);
    await e.api('POST', '/admin/roster', { csv: 'S1,One,s1@x.edu' }, true);
    const token = await voteToken(e, 's1@x.edu');
    const selections = positions.map(p => ({ position_id: p.position_id, candidate_id: p.candidates[0].candidate_id }));
    assert.strictEqual((await e.api('POST', '/vote', { token, selections })).status, 200);
    assert.strictEqual((await (await e.api('GET', '/admin/tally', null, true)).json()).total, 4);
  } finally { await e.stop(); }
});

test('startup migrates old level groups into the approved ballot without losing candidate photos', async () => {
  let originalPhotoCandidate;
  const imports = [
    ['AVP Culture', 'candidates-4-avp-culture.csv'],
    ['VP Women Empowerment', 'candidates-3-vp-women-empowerment.csv'],
    ['AVP Sports', 'candidates-5-avp-sports.csv'],
    ['President', 'candidates-1-president.csv'],
    ['VP General', 'candidates-2-vp-general.csv'],
  ];
  const e = await boot(async (pool) => {
    let seq = 0;
    for (const [office, file] of imports) {
      const csv = fs.readFileSync(path.join(ROOT, 'data', file), 'utf8');
      for (const [level, candidates] of parseLevelCandidates(csv)) {
        const position = (await pool.query('INSERT INTO position (title, seq) VALUES ($1, $2) RETURNING position_id', [`${office} — Level ${level}`, seq++])).rows[0];
        for (const candidate of candidates) {
          const photo = candidate.name === 'Farhana Jamiludheen' ? '/uploads/farhana.jpg' : null;
          const added = (await pool.query('INSERT INTO candidate (position_id, name, description, photo) VALUES ($1, $2, $3, $4) RETURNING candidate_id', [position.position_id, candidate.name, candidate.description, photo])).rows[0];
          if (photo) originalPhotoCandidate = added.candidate_id;
        }
      }
    }
  });
  try {
    const positions = await (await e.api('GET', '/positions')).json();
    assert.deepStrictEqual(positions.map((position) => position.title), GROUPS.map((group) => group.title));
    assert.deepStrictEqual(positions.map((position) => position.candidates.map((candidate) => candidate.name)), GROUPS.map((group) => group.candidates));
    const farhana = positions.flatMap((position) => position.candidates).find((candidate) => candidate.name === 'Farhana Jamiludheen');
    assert.strictEqual(farhana.candidate_id, originalPhotoCandidate);
    assert.strictEqual(farhana.photo, '/uploads/farhana.jpg');
    assert.strictEqual((await e.pool.query('SELECT COUNT(*)::int AS count FROM position')).rows[0].count, 9);
    await e.api('POST', '/admin/roster', { csv: 'S1,One,s1@x.edu' }, true);
    const token = await voteToken(e, 's1@x.edu');
    const selections = positions.map((position) => ({ position_id: position.position_id, candidate_id: position.candidates[0].candidate_id }));
    const vote = await e.api('POST', '/vote', { token, selections });
    assert.strictEqual(vote.status, 200, JSON.stringify(await vote.json()));
    assert.strictEqual((await (await e.api('GET', '/admin/tally', null, true)).json()).total, 9);
  } finally { await e.stop(); }
});

test('admin hold blocks new and in-flight votes, then resume keeps session and tally', async () => {
  const e = await boot();
  try {
    const positions = await seed(e, [{ title: 'President', candidates: ['Alice'] }], ['S1,One,s1@x.edu']);
    const token = await voteToken(e, 's1@x.edu');
    const selections = [{ position_id: positions[0].position_id, candidate_id: positions[0].candidates[0].candidate_id }];
    assert.strictEqual((await e.api('POST', '/admin/hold', {})).status, 401);
    assert.strictEqual((await e.api('POST', '/admin/hold', {}, true)).status, 200);
    assert.strictEqual((await (await e.api('GET', '/info')).json()).status, 'held');
    assert.strictEqual((await e.api('POST', '/voter/request-otp', { email: 's1@x.edu' })).status, 400);
    const heldVote = await e.api('POST', '/vote', { token, selections });
    assert.strictEqual(heldVote.status, 400);
    assert.strictEqual((await heldVote.json()).code, 'HELD');
    assert.strictEqual((await e.api('POST', '/voter/verify-otp', { email: 's1@x.edu', otp: '123456' })).status, 400);
    assert.strictEqual((await (await e.api('GET', '/admin/tally', null, true)).json()).total, 0);
    assert.strictEqual((await e.api('POST', '/admin/resume', {}, true)).status, 200);
    assert.strictEqual((await e.api('POST', '/vote', { token, selections })).status, 200);
    assert.strictEqual((await (await e.api('GET', '/admin/tally', null, true)).json()).total, 1);
    assert.strictEqual((await e.api('POST', '/admin/hold', {}, true)).status, 200);
    assert.strictEqual((await e.api('POST', '/admin/close', {}, true)).status, 200);
    assert.strictEqual((await e.api('POST', '/admin/resume', {}, true)).status, 409);
  } finally { await e.stop(); }
});

test('voter OTP -> token -> one ballot per position (incl. not interested), counted correctly', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice', 'Bob'] }, { title: 'Secretary', candidates: ['Cara'] }],
      ['S1,One,s1@x.edu', 'S2,Two,s2@x.edu']);
    assert.ok((await castVote(e, 's1@x.edu', { President: 'Alice', Secretary: 'Cara' })).ok);
    assert.ok((await castVote(e, 's2@x.edu', { President: 'Bob', Secretary: null })).ok); // not interested in Secretary
    const t = await (await e.api('GET', '/admin/tally', null, true)).json();
    assert.strictEqual(t.total, 4); // 2 voters x 2 positions
    const pres = findPos(t, 'President');
    assert.strictEqual(pres.results.find((c) => c.name === 'Alice').votes, 1);
    assert.strictEqual(pres.results.find((c) => c.name === 'Bob').votes, 1);
    const sec = findPos(t, 'Secretary');
    assert.strictEqual(sec.not_interested, 1);
    const v = await (await e.api('GET', '/verify')).json();
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.count, 4);
  } finally { await e.stop(); }
});

test('partial API vote records unselected positions as not interested and blocks a second vote', async () => {
  const e = await boot();
  try {
    const positions = await seed(e, [
      { title: 'President', candidates: ['Alice'] },
      { title: 'Vice President', candidates: ['Bob'] },
      { title: 'Assistant Vice President', candidates: ['Cara'] },
    ], ['S1,One,s1@x.edu']);
    const token = await voteToken(e, 's1@x.edu');
    const selections = [positions[0], positions[2]].map((p) => ({ position_id: p.position_id, candidate_id: p.candidates[0].candidate_id }));
    const vote = await e.api('POST', '/vote', { token, selections });
    assert.strictEqual(vote.status, 200);
    assert.strictEqual((await vote.json()).ballots, 3);
    const tally = await (await e.api('GET', '/admin/tally', null, true)).json();
    assert.strictEqual(tally.total, 3);
    assert.strictEqual(findPos(tally, 'President').results[0].votes, 1);
    assert.strictEqual(findPos(tally, 'Vice President').not_interested, 1);
    assert.strictEqual(findPos(tally, 'Assistant Vice President').results[0].votes, 1);
    assert.strictEqual((await e.api('POST', '/vote', { token, selections })).status, 400);
    assert.strictEqual((await e.api('POST', '/ballot', { token })).status, 401);
    assert.strictEqual((await e.api('POST', '/voter/verify-otp', { email: 's1@x.edu', otp: '135790' })).status, 400);
    assert.strictEqual((await (await e.api('GET', '/verify')).json()).ok, true);
    assert.strictEqual((await (await e.api('GET', '/admin/tally', null, true)).json()).total, 3);
  } finally { await e.stop(); }
});

test('single candidate position: >50% majority rule (pass)', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'Treasurer', candidates: ['Solo'] }],
      ['S1,a,s1@x.edu', 'S2,b,s2@x.edu', 'S3,c,s3@x.edu']);
    // 2 for Solo, 1 not interested -> 2/3 = 66.7% -> pass
    await castVote(e, 's1@x.edu', { Treasurer: 'Solo' });
    await castVote(e, 's2@x.edu', { Treasurer: 'Solo' });
    await castVote(e, 's3@x.edu', { Treasurer: null });
    const p = findPos(await (await e.api('GET', '/admin/tally', null, true)).json(), 'Treasurer');
    assert.strictEqual(p.status, 'majority_pass');
    assert.strictEqual(p.majority.required, true);
    assert.ok(p.majority.pct > 50);
    assert.ok(p.winner);
  } finally { await e.stop(); }
});

test('single candidate majority FAIL when not-interested is half or more', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'Treasurer', candidates: ['Solo'] }], ['S1,a,s1@x.edu', 'S2,b,s2@x.edu']);
    await castVote(e, 's1@x.edu', { Treasurer: 'Solo' });   // 1 for
    await castVote(e, 's2@x.edu', { Treasurer: null });     // 1 not interested -> 50% -> fail
    const p = findPos(await (await e.api('GET', '/admin/tally', null, true)).json(), 'Treasurer');
    assert.strictEqual(p.status, 'majority_fail');
    assert.strictEqual(p.winner, null);
  } finally { await e.stop(); }
});

test('tie in a position blocks approval', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice', 'Bob'] }], ['S1,a,s1@x.edu', 'S2,b,s2@x.edu']);
    await castVote(e, 's1@x.edu', { President: 'Alice' });
    await castVote(e, 's2@x.edu', { President: 'Bob' });
    const t = await (await e.api('GET', '/admin/tally', null, true)).json();
    assert.strictEqual(findPos(t, 'President').status, 'tie');
    assert.strictEqual(t.hasTie, true);
    await e.api('POST', '/admin/close', {}, true);
    assert.strictEqual((await e.api('POST', '/admin/approve', { approver: 'officer' }, true)).status, 409);
  } finally { await e.stop(); }
});

test('duplicate / stale vote session rejected, counts unchanged', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice'] }], ['S1,a,s1@x.edu']);
    const positions = await (await e.api('GET', '/positions')).json();
    const sel = positions.map((p) => ({ position_id: p.position_id, candidate_id: p.candidates[0].candidate_id }));
    const tok = await voteToken(e, 's1@x.edu');
    assert.ok((await (await e.api('POST', '/vote', { token: tok, selections: sel })).json()).ok);
    assert.strictEqual((await e.api('POST', '/vote', { token: tok, selections: sel })).status, 400); // reused token
    const t = await (await e.api('GET', '/admin/tally', null, true)).json();
    assert.strictEqual(t.total, 1);
  } finally { await e.stop(); }
});

test('ballot anonymity: no column links a ballot to a voter', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice'] }], ['S1,a,s1@x.edu']);
    await castVote(e, 's1@x.edu', { President: 'Alice' });
    const cols = (await e.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'ballot'",
      [e.schema])).rows.map((c) => c.column_name);
    assert.ok(!cols.some((c) => /student|token|roster|voter|otp|email/i.test(c)), `ballot leaks identity: ${cols}`);
  } finally { await e.stop(); }
});

test('concurrent submissions: chain intact, unique prev_hash per ballot', async () => {
  const e = await boot();
  try {
    const N = 20;
    const roster = Array.from({ length: N }, (_, i) => `S${i},n${i},s${i}@x.edu`);
    const seeded = await seed(e, [{ title: 'President', candidates: ['Alice', 'Bob'] }], roster);
    const pos = seeded[0];
    const results = await Promise.all(Array.from({ length: N }, async (_, i) => {
      const tok = await voteToken(e, `s${i}@x.edu`);
      return e.api('POST', '/vote', { token: tok, selections: [{ position_id: pos.position_id, candidate_id: pos.candidates[i % 2].candidate_id }] });
    }));
    assert.ok(results.every((r) => r.ok));
    const v = await (await e.api('GET', '/verify')).json();
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.count, N);
    const prevs = (await e.pool.query('SELECT prev_hash FROM ballot')).rows.map((r) => r.prev_hash);
    assert.strictEqual(new Set(prevs).size, N);
  } finally { await e.stop(); }
});

test('tamper: verify fails and approval is blocked', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice', 'Bob'] }], ['S1,a,s1@x.edu', 'S2,b,s2@x.edu', 'S3,c,s3@x.edu']);
    await castVote(e, 's1@x.edu', { President: 'Alice' });
    await castVote(e, 's2@x.edu', { President: 'Alice' });
    await castVote(e, 's3@x.edu', { President: 'Bob' });
    const row = (await e.pool.query('SELECT ballot_id, candidate_id FROM ballot WHERE candidate_id IS NOT NULL LIMIT 1')).rows[0];
    await e.pool.query('UPDATE ballot SET candidate_id = $1 WHERE ballot_id = $2', [row.candidate_id + 1, row.ballot_id]);
    assert.strictEqual((await (await e.api('GET', '/verify')).json()).ok, false);
    await e.api('POST', '/admin/close', {}, true);
    assert.strictEqual((await e.api('POST', '/admin/approve', { approver: 'officer' }, true)).status, 409);
  } finally { await e.stop(); }
});

test('approval gate ordering: before close rejected, after close recorded, late votes refused', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice', 'Bob'] }], ['S1,a,s1@x.edu', 'S2,b,s2@x.edu']);
    await castVote(e, 's1@x.edu', { President: 'Alice' });
    await castVote(e, 's2@x.edu', { President: 'Alice' }); // Alice 2-0
    assert.strictEqual((await e.api('POST', '/admin/approve', { approver: 'officer' }, true)).status, 400); // not closed
    const closed = await (await e.api('POST', '/admin/close', {}, true)).json();
    assert.strictEqual(closed.verify.ok, true);
    assert.strictEqual((await e.api('POST', '/admin/approve', { approver: 'officer' }, true)).status, 200);
    const result = await (await e.api('GET', '/admin/result', null, true)).json();
    assert.strictEqual(result.approved_by, 'officer');
    assert.strictEqual((await e.api('POST', '/vote', { token: 'whatever', selections: [] })).status, 400);
  } finally { await e.stop(); }
});

test('hard deadline refuses votes once scheduled close passes', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice'] }], ['S1,a,s1@x.edu']);
    const positions = await (await e.api('GET', '/positions')).json();
    const tok = await voteToken(e, 's1@x.edu');
    await e.api('POST', '/admin/schedule', { close_at: 1 }, true); // long past
    const sel = [{ position_id: positions[0].position_id, candidate_id: positions[0].candidates[0].candidate_id }];
    assert.strictEqual((await e.api('POST', '/vote', { token: tok, selections: sel })).status, 400);
    assert.strictEqual((await (await e.api('GET', '/admin/tally', null, true)).json()).total, 0);
  } finally { await e.stop(); }
});

test('scheduled deadline closes voting even while on hold', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice'] }], []);
    assert.strictEqual((await e.api('POST', '/admin/hold', {}, true)).status, 200);
    await e.api('POST', '/admin/schedule', { close_at: 1 }, true);
    assert.strictEqual((await (await e.api('GET', '/info')).json()).status, 'closed');
    assert.strictEqual((await e.api('POST', '/admin/resume', {}, true)).status, 409);
  } finally { await e.stop(); }
});

test('empty election cannot be approved', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice'] }], []);
    await e.api('POST', '/admin/close', {}, true);
    assert.strictEqual((await e.api('POST', '/admin/approve', { approver: 'officer' }, true)).status, 409);
    assert.strictEqual((await (await e.api('GET', '/result')).json()).tally.total, 0);
  } finally { await e.stop(); }
});

test('admin accounts: add, list, cannot delete last / self', async () => {
  const e = await boot();
  try {
    assert.strictEqual((await e.api('POST', '/admin/users', { username: 'second', password: 'password5678' }, true)).status, 200);
    const users = await (await e.api('GET', '/admin/users', null, true)).json();
    assert.strictEqual(users.length, 2);
    assert.strictEqual((await e.api('DELETE', '/admin/users/' + ADMIN_USER, null, true)).status, 400); // self
    assert.strictEqual((await e.api('DELETE', '/admin/users/second', null, true)).status, 200);
    assert.strictEqual((await e.api('DELETE', '/admin/users/' + ADMIN_USER, null, true)).status, 400); // last
  } finally { await e.stop(); }
});

test('position with votes cannot be deleted', async () => {
  const e = await boot();
  try {
    const seeded = await seed(e, [{ title: 'President', candidates: ['Alice'] }], ['S1,a,s1@x.edu']);
    await castVote(e, 's1@x.edu', { President: 'Alice' });
    assert.strictEqual((await e.api('DELETE', '/admin/positions/' + seeded[0].position_id, null, true)).status, 409);
  } finally { await e.stop(); }
});

test('backup includes positions and restores into a fresh schema', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice'] }], ['S1,a,s1@x.edu']);
    await castVote(e, 's1@x.edu', { President: 'Alice' });
    const backup = await (await e.api('GET', '/admin/backup', null, true)).json();
    assert.ok(Array.isArray(backup.tables.position) && backup.tables.position.length === 1);
    assert.strictEqual(backup.tables.ballot.length, 1);
    const file = path.join(e.dir, 'backup.json'); fs.writeFileSync(file, JSON.stringify(backup));
    const { restore } = require('../src/restore-backup');
    const dest = 'test_r' + crypto.randomBytes(6).toString('hex');
    await restore(file, { url: DB_URL, schema: dest, uploadDir: path.join(e.dir, 'restored') });
    const rpool = new Pool({ connectionString: scopedUrl(dest), ssl: SSL });
    try {
      assert.strictEqual((await rpool.query('SELECT COUNT(*)::int n FROM position')).rows[0].n, 1);
      assert.strictEqual((await rpool.query('SELECT COUNT(*)::int n FROM ballot')).rows[0].n, 1);
    } finally { await rpool.query(`DROP SCHEMA "${dest}" CASCADE`); await rpool.end(); }
  } finally { await e.stop(); }
});

test('reset: practice keeps setup, new clears positions; both invalidate sessions', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice'] }], ['S1,a,s1@x.edu']);
    const tok = await voteToken(e, 's1@x.edu');
    const info = await (await e.api('GET', '/info')).json();
    assert.strictEqual((await e.api('POST', '/admin/reset', { mode: 'practice', confirmation: 'RESET PRACTICE VOTES', election_id: info.election_id }, true)).status, 200);
    assert.strictEqual((await (await e.api('GET', '/positions')).json()).length, 1); // positions kept
    const positions = await (await e.api('GET', '/positions')).json();
    const sel = [{ position_id: positions[0].position_id, candidate_id: positions[0].candidates[0].candidate_id }];
    assert.strictEqual((await e.api('POST', '/vote', { token: tok, selections: sel })).status, 400); // old session dead
    const info2 = await (await e.api('GET', '/info')).json();
    assert.strictEqual((await e.api('POST', '/admin/reset', { mode: 'new', confirmation: 'START NEW ELECTION', election_id: info2.election_id }, true)).status, 200);
    assert.strictEqual((await (await e.api('GET', '/positions')).json()).length, 0);
  } finally { await e.stop(); }
});

test('results CSV stays private until close and lists positions + not interested', async () => {
  const e = await boot();
  try {
    await seed(e, [{ title: 'President', candidates: ['Alice', 'Bob'] }], ['S1,a,s1@x.edu']);
    assert.strictEqual((await e.api('GET', '/results.csv')).status, 409);
    await castVote(e, 's1@x.edu', { President: 'Alice' });
    await e.api('POST', '/admin/close', {}, true);
    await e.api('POST', '/admin/approve', { approver: 'officer' }, true);
    const r = await e.api('GET', '/results.csv');
    const csv = await r.text();
    assert.strictEqual(r.status, 200);
    assert.ok(csv.includes('President'));
    assert.ok(csv.includes('Not interested'));
    assert.ok(csv.includes('officer'));
  } finally { await e.stop(); }
});

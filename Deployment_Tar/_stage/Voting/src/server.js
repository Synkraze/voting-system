const express = require('express');
const path = require('path');
const db = require('./db');
const { importRoster } = require('./roster');
const { castBallot } = require('./cast');
const { tally } = require('./tally');
const { verifyChain } = require('./verify');
const { sign, token, sha256 } = require('./crypto');
const { smtpConfigured, sendOtp } = require('./mailer');
const { value, closeElection, syncDeadline, initElection, changeVotingStatus } = require('./election');
const { parseLevelCandidates, levelFromDescription } = require('./level-import');
const { splitLevelPositions } = require('./level-positions');
const auth = require('./auth');
const management = require('./management');
const { editable, removePhoto } = management;

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Admins authenticate with username + password (/admin/login) and carry a signed
// session token on every admin request. Voters authenticate with email + OTP.
const adminOnly = auth.adminSession;

// Requests synchronize scheduled closing before serving election state.
app.use(async (req, res, next) => { res.set('Cache-Control', 'no-store'); try { await syncDeadline(); next(); } catch (e) { next(e); } });
management(app, adminOnly);

async function seedCandidates(position_id, items, byLevel = false) {
  return db.tx(async (c) => {
    if (byLevel && (await c.query('SELECT 1 FROM ballot LIMIT 1')).rowCount) {
      throw Object.assign(new Error('Level-wise candidates must be set before the first vote.'), { status: 409 });
    }
    const ids = [];
    for (const it of items) {
      const r = await c.query('INSERT INTO candidate (position_id, name, description) VALUES ($1, $2, $3) RETURNING candidate_id', [position_id, it.name, it.description || null]);
      ids.push(r.rows[0].candidate_id);
    }
    let grouped = false;
    if (byLevel) {
      const result = await splitLevelPositions(c, position_id);
      if (result.blocked || result.skipped) throw Object.assign(new Error('All candidates in this position need a valid final Level N field before they can be split.'), { status: 400 });
      grouped = result.changed;
    }
    return { ids, grouped };
  }, { lock: true });
}

// Parse candidate input: CSV ("Name,Description" per line) or [{name,description}].
function parseCandidates(body) {
  if (typeof body.csv === 'string') {
    return body.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf(',');
      return i < 0
        ? { name: l, description: null }
        : { name: l.slice(0, i).trim(), description: l.slice(i + 1).trim() || null };
    }).filter((c) => c.name);
  }
  if (Array.isArray(body.candidates)) {
    return body.candidates
      .map((c) => ({ name: String(c.name || '').trim(), description: c.description ? String(c.description).trim() : null }))
      .filter((c) => c.name);
  }
  if (Array.isArray(body.names)) { // back-compat
    return body.names.map((n) => ({ name: String(n).trim(), description: null })).filter((c) => c.name);
  }
  return [];
}

// --- Positions ---

// Public: the ballot, grouped by position — active candidates only.
app.get('/positions', async (req, res, next) => {
  try {
    const positions = await db.query('SELECT position_id, title, seq FROM position ORDER BY seq, position_id');
    const cands = await db.query('SELECT candidate_id, position_id, name, description, photo FROM candidate WHERE active = 1 ORDER BY candidate_id');
    res.json(positions.map((p) => ({ ...p, candidates: cands.filter((c) => c.position_id === p.position_id) })));
  } catch (e) { next(e); }
});

app.get('/admin/positions', adminOnly, async (req, res, next) => {
  try { res.json(await db.query('SELECT position_id, title, seq FROM position ORDER BY seq, position_id')); } catch (e) { next(e); }
});

app.post('/admin/positions', adminOnly, editable, async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title || title.length > 120) return res.status(400).json({ error: 'Position title is required (max 120 characters).' });
    const seq = Number.isFinite(Number(req.body.seq)) ? Number(req.body.seq) : 0;
    const r = await db.one('INSERT INTO position (title, seq) VALUES ($1, $2) RETURNING position_id', [title, seq]);
    res.json({ position_id: r.position_id });
  } catch (e) { next(e); }
});

// Import one office CSV as separate races, one per level. All rows commit
// together, before voting begins, so every voter sees the same ballot groups.
app.post('/admin/positions/import-levels', adminOnly, editable, async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title || title.length > 100) return res.status(400).json({ error: 'Enter a position name (max 100 characters).' });
    let groups;
    try { groups = parseLevelCandidates(req.body.csv); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const created = await db.tx(async (c) => {
      const status = (await c.query("SELECT value FROM meta WHERE key = 'status'")).rows[0]?.value;
      if (status !== 'open' && status !== 'held') throw Object.assign(new Error('Election is closed.'), { status: 409 });
      if ((await c.query('SELECT 1 FROM ballot LIMIT 1')).rowCount) throw Object.assign(new Error('Import level files before the first vote is cast.'), { status: 409 });
      const titles = groups.map(([level]) => `${title} — Level ${level}`);
      const existing = (await c.query('SELECT title FROM position WHERE title = ANY($1)', [titles])).rows;
      if (existing.length) throw Object.assign(new Error(`${existing[0].title} already exists. Remove it before importing this file again.`), { status: 409 });
      const out = [];
      const nextSeq = Number((await c.query('SELECT COALESCE(MAX(seq), 0)::int AS n FROM position')).rows[0].n) + 1;
      for (const [index, [level, candidates]] of groups.entries()) {
        const positionTitle = `${title} — Level ${level}`;
        const p = (await c.query('INSERT INTO position (title, seq) VALUES ($1, $2) RETURNING position_id', [positionTitle, nextSeq + index])).rows[0];
        for (const candidate of candidates) await c.query('INSERT INTO candidate (position_id, name, description) VALUES ($1, $2, $3)', [p.position_id, candidate.name, candidate.description]);
        out.push({ position_id: p.position_id, title: positionTitle, candidates: candidates.length });
      }
      return out;
    }, { lock: true });
    res.json({ created });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

app.patch('/admin/positions/:id', adminOnly, editable, async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title || title.length > 120) return res.status(400).json({ error: 'Position title is required (max 120 characters).' });
    const seq = Number.isFinite(Number(req.body.seq)) ? Number(req.body.seq) : 0;
    const r = await db.run('UPDATE position SET title = $1, seq = $2 WHERE position_id = $3', [title, seq, Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Position not found.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Delete a position (and its candidates) — blocked once any ballot references it.
app.delete('/admin/positions/:id', adminOnly, editable, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if ((await db.one('SELECT COUNT(*)::int AS c FROM ballot WHERE position_id = $1', [id])).c > 0) {
      return res.status(409).json({ error: 'This position already has votes; it cannot be deleted.' });
    }
    if (!await db.one('SELECT 1 FROM position WHERE position_id = $1', [id])) return res.status(404).json({ error: 'Position not found.' });
    const photos = await db.query('SELECT photo FROM candidate WHERE position_id = $1 AND photo IS NOT NULL', [id]);
    await db.tx(async (c) => {
      await c.query('DELETE FROM candidate WHERE position_id = $1', [id]);
      await c.query('DELETE FROM position WHERE position_id = $1', [id]);
    });
    photos.forEach((p) => removePhoto(p.photo));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Candidates ---

// Admin: full candidate list including withdrawn, with position and active flag.
app.get('/admin/candidates', adminOnly, async (req, res, next) => {
  try { res.json(await db.query('SELECT candidate_id, position_id, name, description, photo, active FROM candidate ORDER BY candidate_id')); } catch (e) { next(e); }
});

// Admin: withdraw / reactivate a candidate (keeps their existing votes).
app.post('/admin/candidates/:id/active', adminOnly, editable, async (req, res, next) => {
  try {
    if (typeof req.body.active !== 'boolean') return res.status(400).json({ error: 'active must be a boolean' });
    const r = await db.run('UPDATE candidate SET active = $1 WHERE candidate_id = $2', [req.body.active ? 1 : 0, Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Candidate not found.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Admin console: add candidates to a position (CSV or list, with descriptions).
app.post('/admin/candidates', adminOnly, editable, async (req, res, next) => {
  try {
    const position_id = Number(req.body.position_id);
    if (!position_id || !await db.one('SELECT 1 FROM position WHERE position_id = $1', [position_id])) {
      return res.status(400).json({ error: 'Choose a valid position for these candidates.' });
    }
    const items = parseCandidates(req.body);
    if (!items.length) return res.status(400).json({ error: 'no candidates provided' });
    if (items.some((c) => c.name.length > 120 || (c.description || '').length > 1000)) return res.status(400).json({ error: 'Name max 120 characters; description max 1,000.' });
    const levels = items.map(c => levelFromDescription(c.description));
    const byLevel = typeof req.body.csv === 'string' && levels.some(level => level !== null);
    if (byLevel && levels.some(level => level === null)) return res.status(400).json({ error: 'Every candidate in a level CSV needs a final Level N field.' });
    const { ids, grouped } = await seedCandidates(position_id, items, byLevel);
    res.json({ added: items.length, ids, grouped });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// Delete a candidate — blocked once it has votes (would corrupt the tally).
app.delete('/admin/candidates/:id', adminOnly, editable, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if ((await db.one('SELECT COUNT(*)::int AS c FROM ballot WHERE candidate_id = $1', [id])).c > 0) {
      return res.status(409).json({ error: 'candidate already has votes; cannot delete' });
    }
    const candidate = await db.one('SELECT photo FROM candidate WHERE candidate_id = $1', [id]);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
    await db.run('DELETE FROM candidate WHERE candidate_id = $1', [id]);
    removePhoto(candidate.photo);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Election info & schedule ---

// Public election info — drives title, live clock and countdown on every page.
app.get('/info', async (req, res, next) => {
  try {
    const rows = await db.query("SELECT key, value FROM meta WHERE key IN ('election_id','title','description','status','close_at')");
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({
      election_id: m.election_id,
      title: m.title || 'Campus Election',
      description: m.description || '',
      status: m.status,
      close_at: m.close_at ? Number(m.close_at) : null,
      now: Date.now(),
    });
  } catch (e) { next(e); }
});

// Admin: set election title and scheduled close time (epoch ms, or null/0 to clear).
app.post('/admin/schedule', adminOnly, editable, async (req, res, next) => {
  try {
    if (req.body.close_at != null && req.body.close_at !== '' && (!Number.isFinite(Number(req.body.close_at)) || Number(req.body.close_at) < 0 || Number(req.body.close_at) > 8640000000000000)) return res.status(400).json({ error: 'Invalid close time.' });
    const set = (k, v) => db.run('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
    if (typeof req.body.title === 'string' && req.body.title.trim()) await set('title', req.body.title.trim());
    if (typeof req.body.description === 'string') await set('description', req.body.description.trim());
    if ('close_at' in req.body) await set('close_at', req.body.close_at ? String(Number(req.body.close_at)) : '');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/admin/roster', adminOnly, editable, async (req, res) => {
  if (typeof req.body.csv !== 'string') return res.status(400).json({ error: 'csv string required' });
  try { res.json({ added: await importRoster(req.body.csv) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

// --- Admin accounts & sessions ---

app.post('/admin/login', async (req, res, next) => {
  try {
    const tok = await auth.authenticateAdmin(req.body.username, req.body.password);
    if (!tok) return res.status(401).json({ error: 'Invalid username or password.' });
    res.json({ token: tok });
  } catch (e) { next(e); }
});

app.get('/admin/me', adminOnly, (req, res) => res.json({ username: req.admin.username }));

app.get('/admin/users', adminOnly, async (req, res, next) => {
  try { res.json(await db.query('SELECT username, created_at FROM admin_user ORDER BY username')); } catch (e) { next(e); }
});

app.post('/admin/users', adminOnly, async (req, res) => {
  try {
    const { username } = await auth.createAdmin(req.body.username, req.body.password);
    res.json({ ok: true, username });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/admin/users/:username', adminOnly, async (req, res, next) => {
  try {
    const target = String(req.params.username || '').trim().toLowerCase();
    if (target === req.admin.username) return res.status(400).json({ error: 'You cannot delete the account you are signed in as.' });
    if ((await db.one('SELECT COUNT(*)::int AS n FROM admin_user')).n <= 1) return res.status(400).json({ error: 'Cannot delete the last admin account.' });
    const r = await db.run('DELETE FROM admin_user WHERE username = $1', [target]);
    if (!r.rowCount) return res.status(404).json({ error: 'Admin not found.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Voter OTP login ---

// Request a one-time code. Enumeration-safe: identical response whether or not
// the email is on the roster / still eligible.
app.post('/voter/request-otp', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (await value('status') !== 'open') return res.status(400).json({ error: 'Voting is temporarily on hold or closed.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!smtpConfigured()) return res.status(400).json({ error: 'Email delivery is not configured. Contact the election office.' });
    const generic = { ok: true, message: 'If that email is eligible to vote, a code has been sent.' };
    const voter = await db.one('SELECT student_id, name, email FROM roster WHERE lower(email) = $1 AND token_used = 0', [email]);
    if (!voter) return res.json(generic);
    const otp = auth.generateOtp();
    await db.run('UPDATE roster SET otp_hash = $1, otp_expires = $2, otp_attempts = 0 WHERE student_id = $3',
      [auth.hashOtp(email, otp), Date.now() + auth.OTP_TTL_MS, voter.student_id]);
    try {
      await sendOtp({ to: voter.email, name: voter.name, otp, title: await value('title') || 'Campus Election', ttlMin: Math.round(auth.OTP_TTL_MS / 60000) });
    } catch {
      await db.run('UPDATE roster SET otp_hash = NULL, otp_expires = NULL WHERE student_id = $1', [voter.student_id]);
      return res.status(502).json({ error: 'Could not send the code right now. Please try again shortly.' });
    }
    res.json(generic);
  } catch (e) { next(e); }
});

// Verify the code -> issue a one-time vote session token.
app.post('/voter/verify-otp', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const otp = String(req.body.otp || '').trim();
    if (await value('status') !== 'open') return res.status(400).json({ error: 'Voting is temporarily on hold or closed.' });
    const voter = await db.one('SELECT student_id, otp_hash, otp_expires, otp_attempts FROM roster WHERE lower(email) = $1 AND token_used = 0', [email]);
    const bad = () => res.status(400).json({ error: 'Invalid or expired code.' });
    const clear = (id) => db.run('UPDATE roster SET otp_hash = NULL, otp_expires = NULL WHERE student_id = $1', [id]);
    if (!voter || !voter.otp_hash) return bad();
    if (Number(voter.otp_expires) < Date.now()) { await clear(voter.student_id); return bad(); }
    if (voter.otp_attempts >= auth.OTP_MAX_ATTEMPTS) { await clear(voter.student_id); return res.status(429).json({ error: 'Too many attempts. Request a new code.' }); }
    if (auth.hashOtp(email, otp) !== voter.otp_hash) {
      await db.run('UPDATE roster SET otp_attempts = otp_attempts + 1 WHERE student_id = $1', [voter.student_id]);
      return bad();
    }
    const raw = token();
    await db.run('UPDATE roster SET checked_in = 1, token_hash = $1, otp_hash = NULL, otp_expires = NULL, otp_attempts = 0 WHERE student_id = $2', [sha256(raw), voter.student_id]);
    res.json({ token: raw });
  } catch (e) { next(e); }
});

// Public vote: token + selections [{position_id, candidate_id|null}]. One ballot
// per position, cast in one advisory-locked transaction.
app.post('/vote', async (req, res) => {
  try {
    const result = await castBallot(String(req.body.token || ''), req.body.selections, Date.now());
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// --- Counting, verification, approval ---
const meta = (key) => db.one('SELECT value FROM meta WHERE key = $1', [key]).then((r) => r?.value);

// Public: independent audit. No identity in ballot to leak.
app.get('/verify', async (req, res, next) => { try { res.json(await verifyChain()); } catch (e) { next(e); } });

app.get('/admin/tally', adminOnly, async (req, res, next) => { try { res.json(await tally()); } catch (e) { next(e); } });

// Close voting: freeze status, run verification, pin the root, drop token hashes.
app.post('/admin/close', adminOnly, async (req, res, next) => {
  try {
    if (await meta('status') === 'closed') return res.status(400).json({ error: 'already closed' });
    const v = await closeElection();
    res.json({ closed: true, verify: v });
  } catch (e) { next(e); }
});

app.post('/admin/hold', adminOnly, async (req, res, next) => {
  try {
    if (!await changeVotingStatus('open', 'held')) return res.status(409).json({ error: 'Voting is already on hold or closed.' });
    res.json({ status: 'held' });
  } catch (e) { next(e); }
});

app.post('/admin/resume', adminOnly, async (req, res, next) => {
  try {
    if (!await changeVotingStatus('held', 'open')) return res.status(409).json({ error: 'Voting is not on hold, or its deadline has passed.' });
    res.json({ status: 'open' });
  } catch (e) { next(e); }
});

// Approve: hard-gated on closed + verify.ok. Signs over root|positions as the record.
app.post('/admin/approve', adminOnly, async (req, res, next) => {
  try {
    const approver = String(req.body.approver || '').trim();
    if (!approver) return res.status(400).json({ error: 'approver required' });
    if (await meta('status') !== 'closed') return res.status(400).json({ error: 'close voting first' });
    const v = await verifyChain();
    if (!v.ok) return res.status(409).json({ error: 'verification failed; cannot approve', verify: v });
    const t = await tally();
    if (t.total === 0) return res.status(409).json({ error: 'no votes cast; nothing to approve', tally: t });
    if (t.hasTie) return res.status(409).json({ error: 'a position is tied; resolve it before approval', tally: t });
    const signature = sign(`${v.root}|${JSON.stringify(t.positions)}`);
    await db.tx(async (c) => {
      const set = (k, val) => c.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, val]);
      await set('approved_by', approver);
      await set('approval_sig', signature);
      await set('approved_at', new Date().toISOString());
    });
    res.json({ approved: true, by: approver, root: v.root });
  } catch (e) { next(e); }
});

// Live turnout + tally for the admin analytics dashboard.
app.get('/admin/stats', adminOnly, async (req, res, next) => {
  try {
    const r = await db.one('SELECT COUNT(*)::int AS eligible, COALESCE(SUM(checked_in),0)::int AS checked_in, COALESCE(SUM(token_used),0)::int AS voted FROM roster');
    const t = await tally();
    res.json({
      status: await meta('status'),
      eligible: r.eligible, checked_in: r.checked_in, voted: r.voted, ballots: t.total,
      turnout_pct: r.eligible ? Math.round((r.voted / r.eligible) * 1000) / 10 : 0,
      tally: t, verify: await verifyChain(),
    });
  } catch (e) { next(e); }
});

// Public results — only AFTER close, so live counts never leak during voting.
app.get('/result', async (req, res, next) => {
  try {
    if (await meta('status') !== 'closed') return res.json({ status: 'open' });
    res.json({
      status: 'closed', root: await meta('root') || null,
      approved_by: await meta('approved_by') || null, approved_at: await value('approved_at') || null,
      title: await value('title') || 'Campus Election', election_id: await value('election_id'),
      verify: await verifyChain(), tally: await tally(),
    });
  } catch (e) { next(e); }
});

// Admin final result view: tally + verification + approval state.
app.get('/admin/result', adminOnly, async (req, res, next) => {
  try {
    res.json({
      status: await meta('status'), root: await meta('root') || null,
      approved_by: await meta('approved_by') || null, approved_at: await value('approved_at') || null,
      title: await value('title') || 'Campus Election', election_id: await value('election_id'),
      verify: await verifyChain(), tally: await tally(),
    });
  } catch (e) { next(e); }
});

app.use((error, req, res, next) => {
  const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: status === 413 ? 'Upload too large (maximum photo size: 2 MB).' : status === 400 ? 'Invalid JSON request.' : 'Server could not complete the request. Try again.' });
});

async function main() {
  await db.init();
  await initElection();
  const split = await db.tx(c => splitLevelPositions(c), { lock: true });
  if (split.blocked || split.skipped) console.warn('Some existing candidate positions could not be split by level; check that no votes exist and every candidate has a Level N description.');
  await auth.seedAdminFromEnv();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Voting server on http://localhost:${port}`));
}
if (require.main === module) main().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });

module.exports = app;

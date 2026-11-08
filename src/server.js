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
const { GROUPS, fullPositionTitle, officialImportGroups, arrangeOfficialBallot } = require('./official-ballot');
const { positionAllowsLevel, normalizeLevels } = require('./eligibility');
const auth = require('./auth');

// Official Student Declaration & Consent — shown as required checkboxes before sign-in.
const CONSENT_POINTS = [
  'I confirm that I am an eligible student of the University of West London – RAK Campus.',
  'I understand that my Student ID and registered university email will be used to verify my identity and voting eligibility.',
  'I understand that an OTP will be sent to my registered university email for authentication.',
  'I acknowledge that my identity verification records and ballot records are maintained separately to protect the confidentiality of my vote.',
  'I understand that I am entitled to cast only one vote and that my vote cannot be modified once submitted.',
  'I agree to follow the Student Council Election guidelines and confirm that I am casting my vote voluntarily.',
];
const management = require('./management');
const { editable, removePhoto } = management;

const app = express();

// Security headers (stdlib only, no helmet dep). CSP allows inline because the
// UI relies on inline handlers/styles; it still blocks external scripts and
// frames the admin console/ballot against clickjacking. Google Fonts are the
// only off-origin resource the pages load. HSTS is ignored over plain HTTP.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  });
  // Explicit cross-origin deny: this API is same-origin only (Bearer tokens, no
  // CORS headers ever emitted). Reject state-changing requests whose Origin is a
  // different site so a stray permissive proxy can't open the admin API up.
  const origin = req.get('origin');
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host && host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked.' });
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
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
    const nextSeq = Number((await c.query('SELECT COALESCE(MAX(seq), -1)::int AS n FROM candidate WHERE position_id = $1', [position_id])).rows[0].n) + 1;
    for (let index = 0; index < items.length; index++) {
      const it = items[index];
      const r = await c.query('INSERT INTO candidate (position_id, name, description, seq) VALUES ($1, $2, $3, $4) RETURNING candidate_id', [position_id, it.name, it.description || null, nextSeq + index]);
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

async function seedOfficialCandidates(positionId, groups) {
  return db.tx(async (c) => {
    if ((await c.query('SELECT 1 FROM ballot LIMIT 1')).rowCount) {
      throw Object.assign(new Error('Official candidate arrangement must be set before the first vote.'), { status: 409 });
    }
    const position = (await c.query('SELECT position_id, seq FROM position WHERE position_id = $1', [positionId])).rows[0];
    if (!position) throw Object.assign(new Error('Choose a valid position for these candidates.'), { status: 400 });
    if ((await c.query('SELECT 1 FROM candidate WHERE position_id = $1 LIMIT 1', [positionId])).rowCount) {
      throw Object.assign(new Error('Remove existing candidates from this position before importing the official list.'), { status: 409 });
    }
    const ids = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      const seq = GROUPS.findIndex((official) => official.title === group.title);
      let targetId = positionId;
      if (groupIndex === 0) await c.query('UPDATE position SET title = $1, seq = $2 WHERE position_id = $3', [group.title, seq, positionId]);
      else targetId = (await c.query('INSERT INTO position (title, seq) VALUES ($1, $2) RETURNING position_id', [group.title, seq])).rows[0].position_id;
      for (let candidateIndex = 0; candidateIndex < group.candidates.length; candidateIndex++) {
        const candidate = group.candidates[candidateIndex];
        const row = await c.query('INSERT INTO candidate (position_id, name, description, seq) VALUES ($1, $2, $3, $4) RETURNING candidate_id', [targetId, candidate.name, candidate.description || null, candidateIndex]);
        ids.push(row.rows[0].candidate_id);
      }
    }
    return { ids, grouped: groups.length > 1 };
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
    const cands = await db.query('SELECT candidate_id, position_id, name, description, photo FROM candidate WHERE active = 1 ORDER BY seq, candidate_id');
    res.json(positions.map((p) => ({ ...p, title: fullPositionTitle(p.title), candidates: cands.filter((c) => c.position_id === p.position_id) })));
  } catch (e) { next(e); }
});

// Voter's own ballot: only the positions this voter's level is eligible for.
// Scoped by the one-time vote session token (POST so the token stays out of URLs/logs).
app.post('/ballot', async (req, res, next) => {
  try {
    const voter = await db.one('SELECT level FROM roster WHERE token_hash = $1 AND checked_in = 1 AND token_used = 0', [sha256(String(req.body.token || ''))]);
    if (!voter) return res.status(401).json({ error: 'Your voting session is invalid or has expired. Request a new code.' });
    const positions = await db.query('SELECT position_id, title, seq, elig_levels FROM position ORDER BY seq, position_id');
    const eligible = positions.filter((p) => positionAllowsLevel(p.elig_levels, voter.level));
    const cands = await db.query('SELECT candidate_id, position_id, name, description, photo FROM candidate WHERE active = 1 ORDER BY seq, candidate_id');
    res.json(eligible.map((p) => ({ position_id: p.position_id, title: fullPositionTitle(p.title), candidates: cands.filter((c) => c.position_id === p.position_id) })));
  } catch (e) { next(e); }
});

app.get('/admin/positions', adminOnly, async (req, res, next) => {
  try {
    const positions = await db.query('SELECT position_id, title, seq, elig_levels FROM position ORDER BY seq, position_id');
    res.json(positions.map((position) => ({ ...position, title: fullPositionTitle(position.title) })));
  } catch (e) { next(e); }
});

app.post('/admin/positions', adminOnly, editable, async (req, res, next) => {
  try {
    const title = fullPositionTitle(req.body.title);
    if (!title || title.length > 120) return res.status(400).json({ error: 'Position title is required (max 120 characters).' });
    const seq = Number.isFinite(Number(req.body.seq)) ? Number(req.body.seq) : 0;
    const r = await db.one('INSERT INTO position (title, seq, elig_levels) VALUES ($1, $2, $3) RETURNING position_id', [title, seq, normalizeLevels(req.body.elig_levels)]);
    res.json({ position_id: r.position_id });
  } catch (e) { next(e); }
});

// Import one office CSV as separate races, one per level. All rows commit
// together, before voting begins, so every voter sees the same ballot groups.
app.post('/admin/positions/import-levels', adminOnly, editable, async (req, res, next) => {
  try {
    const title = fullPositionTitle(req.body.title);
    if (!title || title.length > 100) return res.status(400).json({ error: 'Enter a position name (max 100 characters).' });
    let groups;
    try {
      const parsed = parseLevelCandidates(req.body.csv);
      const candidates = parsed.flatMap(([, items]) => items);
      groups = officialImportGroups(title, candidates) || parsed.map(([level, items]) => ({ title: `${title} — Level ${level}`, candidates: items }));
    }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const created = await db.tx(async (c) => {
      const status = (await c.query("SELECT value FROM meta WHERE key = 'status'")).rows[0]?.value;
      if (status !== 'open' && status !== 'held') throw Object.assign(new Error('Election is closed.'), { status: 409 });
      if ((await c.query('SELECT 1 FROM ballot LIMIT 1')).rowCount) throw Object.assign(new Error('Import level files before the first vote is cast.'), { status: 409 });
      const titles = groups.map((group) => group.title);
      const existing = (await c.query('SELECT title FROM position WHERE title = ANY($1)', [titles])).rows;
      if (existing.length) throw Object.assign(new Error(`${existing[0].title} already exists. Remove it before importing this file again.`), { status: 409 });
      const out = [];
      const nextSeq = Number((await c.query('SELECT COALESCE(MAX(seq), 0)::int AS n FROM position')).rows[0].n) + 1;
      for (const [index, group] of groups.entries()) {
        const positionTitle = group.title, candidates = group.candidates;
        const officialIndex = GROUPS.findIndex((official) => official.title === positionTitle);
        const seq = officialIndex < 0 ? nextSeq + index : officialIndex;
        const p = (await c.query('INSERT INTO position (title, seq) VALUES ($1, $2) RETURNING position_id', [positionTitle, seq])).rows[0];
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
          const candidate = candidates[candidateIndex];
          await c.query('INSERT INTO candidate (position_id, name, description, seq) VALUES ($1, $2, $3, $4)', [p.position_id, candidate.name, candidate.description, candidateIndex]);
        }
        out.push({ position_id: p.position_id, title: positionTitle, candidates: candidates.length });
      }
      return out;
    }, { lock: true });
    res.json({ created });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

app.patch('/admin/positions/:id', adminOnly, editable, async (req, res, next) => {
  try {
    const title = fullPositionTitle(req.body.title);
    if (!title || title.length > 120) return res.status(400).json({ error: 'Position title is required (max 120 characters).' });
    const seq = Number.isFinite(Number(req.body.seq)) ? Number(req.body.seq) : 0;
    const elig = 'elig_levels' in req.body ? normalizeLevels(req.body.elig_levels) : undefined;
    const r = elig === undefined
      ? await db.run('UPDATE position SET title = $1, seq = $2 WHERE position_id = $3', [title, seq, Number(req.params.id)])
      : await db.run('UPDATE position SET title = $1, seq = $2, elig_levels = $3 WHERE position_id = $4', [title, seq, elig, Number(req.params.id)]);
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
  try { res.json(await db.query('SELECT candidate_id, position_id, name, description, photo, active FROM candidate ORDER BY position_id, seq, candidate_id')); } catch (e) { next(e); }
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
    const position = position_id ? await db.one('SELECT title FROM position WHERE position_id = $1', [position_id]) : null;
    if (!position) {
      return res.status(400).json({ error: 'Choose a valid position for these candidates.' });
    }
    const items = parseCandidates(req.body);
    if (!items.length) return res.status(400).json({ error: 'no candidates provided' });
    if (items.some((c) => c.name.length > 120 || (c.description || '').length > 1000)) return res.status(400).json({ error: 'Name max 120 characters; description max 1,000.' });
    const levels = items.map(c => levelFromDescription(c.description));
    const byLevel = typeof req.body.csv === 'string' && levels.some(level => level !== null);
    if (byLevel && levels.some(level => level === null)) return res.status(400).json({ error: 'Every candidate in a level CSV needs a final Level N field.' });
    let officialGroups = null;
    if (byLevel) {
      try { officialGroups = officialImportGroups(position.title, items); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
    const { ids, grouped } = officialGroups
      ? await seedOfficialCandidates(position_id, officialGroups)
      : await seedCandidates(position_id, items, byLevel);
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
    const rows = await db.query("SELECT key, value FROM meta WHERE key IN ('election_id','title','description','status','close_at','consent_points')");
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let consentPoints = CONSENT_POINTS;
    if (m.consent_points) { try { const parsed = JSON.parse(m.consent_points); if (Array.isArray(parsed) && parsed.length) consentPoints = parsed.map(String); } catch { /* fall back to default */ } }
    res.json({
      election_id: m.election_id,
      title: m.title || 'Student Council Election 2026',
      description: m.description || '',
      status: m.status,
      close_at: m.close_at ? Number(m.close_at) : null,
      now: Date.now(),
      consent: { title: 'Student Declaration and Consent', points: consentPoints },
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
    if (Array.isArray(req.body.consent_points) || typeof req.body.consent_points === 'string') {
      const arr = (Array.isArray(req.body.consent_points) ? req.body.consent_points : String(req.body.consent_points).split('\n'))
        .map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
      await set('consent_points', JSON.stringify(arr));
    }
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

// Request a one-time code. Unknown emails get the same generic response; a
// roster entry that already voted gets a clear terminal response instead.
app.post('/voter/request-otp', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (await value('status') !== 'open') return res.status(400).json({ error: 'Voting is temporarily on hold or closed.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const generic = { ok: true, message: 'If that email is eligible to vote, a code has been sent.' };
    const voter = await db.one('SELECT student_id, name, email, token_used FROM roster WHERE lower(email) = $1', [email]);
    // Same generic reply whether the email is unknown, eligible, or already
    // voted — never confirm roster membership or participation to an unauthenticated
    // caller. (An already-voted voter simply gets no new code; re-voting is blocked
    // at verify/cast anyway.)
    if (!voter || voter.token_used) return res.json(generic);
    if (!smtpConfigured()) return res.status(400).json({ error: 'Email delivery is not configured. Contact the election office.' });
    const otp = auth.generateOtp();
    // By requesting a code the voter has passed the consent gate; stamp it once (identity side, never on a ballot).
    await db.run('UPDATE roster SET otp_hash = $1, otp_expires = $2, otp_attempts = 0, consented_at = COALESCE(consented_at, $4) WHERE student_id = $3',
      [auth.hashOtp(email, otp), Date.now() + auth.OTP_TTL_MS, voter.student_id, Date.now()]);
    try {
      await sendOtp({ to: voter.email, name: voter.name, otp, title: await value('title') || 'Student Council Election 2026', ttlMin: Math.round(auth.OTP_TTL_MS / 60000) });
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

// Public vote: token + selections [{position_id, candidate_id|null}]. Omitted
// positions and explicit null count as "not interested" votes.
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

// Admin: list ballots (anonymous — position/candidate/time only) with void state.
app.get('/admin/ballots', adminOnly, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const like = '%' + q.replace(/[%_\\]/g, (s) => '\\' + s) + '%';
    const where = q ? "WHERE b.student_id ILIKE $1 OR COALESCE(r.name,'') ILIKE $1 OR COALESCE(c.name,'') ILIKE $1 OR p.title ILIKE $1" : '';
    const rows = await db.query(`
      SELECT b.ballot_id, p.title AS position_title, c.name AS candidate_name,
             b.student_id, r.name AS student_name, b.created_at, b.voided, b.void_reason, b.voided_by, b.voided_at
      FROM ballot b JOIN position p ON p.position_id = b.position_id
      LEFT JOIN candidate c ON c.candidate_id = b.candidate_id
      LEFT JOIN roster r ON r.student_id = b.student_id
      ${where}
      ORDER BY b.seq DESC`, q ? [like] : []);
    res.json(rows.map((b) => ({ ...b, position_title: fullPositionTitle(b.position_title) })));
  } catch (e) { next(e); }
});

// Admin: void (tombstone) or restore a ballot. The row and its hash stay, so the
// chain still verifies; the tally simply ignores voided ballots. A reason is required.
app.post('/admin/ballots/:id/void', adminOnly, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const makeVoid = req.body.void !== false;
    if (makeVoid && !String(req.body.reason || '').trim()) return res.status(400).json({ error: 'A reason is required to void a ballot.' });
    if (!await db.one('SELECT 1 FROM ballot WHERE ballot_id = $1', [id])) return res.status(404).json({ error: 'Ballot not found.' });
    if (makeVoid) await db.run('UPDATE ballot SET voided = 1, void_reason = $1, voided_by = $2, voided_at = $3 WHERE ballot_id = $4', [String(req.body.reason).trim(), req.admin.username, Date.now(), id]);
    else await db.run('UPDATE ballot SET voided = 0, void_reason = NULL, voided_by = NULL, voided_at = NULL WHERE ballot_id = $1', [id]);
    res.json({ ok: true, voided: makeVoid });
  } catch (e) { next(e); }
});

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

// Cumulative turnout over time for the dashboard line chart. Ballots carry no
// voter identity, but every ballot a voter casts in one submission shares a
// single created_at, so COUNT(DISTINCT created_at) per time bucket approximates
// the number of voters who completed in that window — anonymity preserved.
app.get('/admin/stats/timeline', adminOnly, async (req, res, next) => {
  try {
    const BUCKET_MS = 15 * 60 * 1000;
    const rows = await db.query(
      `SELECT (created_at - (created_at % $1::bigint)) AS bucket, COUNT(DISTINCT created_at)::int AS voters
       FROM ballot GROUP BY bucket ORDER BY bucket`, [BUCKET_MS]);
    const eligible = (await db.one('SELECT COUNT(*)::int AS n FROM roster')).n;
    let cumulative = 0;
    const points = rows.map((row) => {
      cumulative += row.voters;
      return { t: Number(row.bucket), voters: row.voters, cumulative };
    });
    res.json({ bucket_ms: BUCKET_MS, eligible, points });
  } catch (e) { next(e); }
});

// Public results — only AFTER close, so live counts never leak during voting.
app.get('/result', async (req, res, next) => {
  try {
    if (await meta('status') !== 'closed') return res.json({ status: 'open' });
    res.json({
      status: 'closed', root: await meta('root') || null,
      approved_by: await meta('approved_by') || null, approved_at: await value('approved_at') || null,
      title: await value('title') || 'Student Council Election 2026', election_id: await value('election_id'),
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
      title: await value('title') || 'Student Council Election 2026', election_id: await value('election_id'),
      verify: await verifyChain(), tally: await tally(),
    });
  } catch (e) { next(e); }
});

app.use((error, req, res, next) => {
  const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: status === 413 ? 'Upload too large (maximum photo size: 5 MB).' : status === 400 ? 'Invalid JSON request.' : 'Server could not complete the request. Try again.' });
});

async function main() {
  await db.init();
  await initElection();
  const arranged = await db.tx(c => arrangeOfficialBallot(c), { lock: true });
  if (!arranged.detected) {
    const split = await db.tx(c => splitLevelPositions(c), { lock: true });
    if (split.blocked || split.skipped) console.warn('Some existing candidate positions could not be split by level; check that no votes exist and every candidate has a Level N description.');
  } else if (arranged.blocked) console.warn('Official candidate arrangement was not changed because ballots already exist; preserving the current election setup.');
  else if (arranged.incomplete) console.warn('Official candidate arrangement is incomplete:', arranged.reason);
  await auth.seedAdminFromEnv();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Voting server on http://localhost:${port}`));
}
if (require.main === module) main().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });

module.exports = app;

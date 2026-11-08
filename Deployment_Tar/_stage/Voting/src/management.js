const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const db = require('./db');
const { value, syncDeadline, resetElection } = require('./election');
const { previewRoster } = require('./roster');
const { tally } = require('./tally');
const { verifyChain } = require('./verify');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const photoName = /^\/uploads\/([a-f0-9-]+\.webp)$/;
function removePhoto(url) {
  const match = photoName.exec(url || '');
  if (match) {
    try { fs.unlinkSync(path.join(uploadDir, match[1])); }
    catch (error) { if (error.code !== 'ENOENT') console.error('Photo cleanup failed:', error.code); }
  }
}
// Async middleware: sync the deadline, then block edits once closed.
async function editable(req, res, next) {
  try {
    await syncDeadline();
    if (await value('status') === 'closed') return res.status(409).json({ code: 'ELECTION_CLOSED', error: 'Election is closed. Setup is locked to preserve the result. Use Backup & reset to reuse the setup or start a new election; resetting clears votes.' });
    next();
  } catch (e) { next(e); }
}
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
module.exports = function install(app, adminOnly) {
  app.use('/uploads', require('express').static(uploadDir, { dotfiles: 'deny', setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); } }));
  app.patch('/admin/candidates/:id', adminOnly, editable, async (req, res, next) => {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
      if (!name || name.length > 120 || description.length > 1000) return res.status(400).json({ error: 'Name is required (max 120 characters); description max 1,000 characters.' });
      const result = await db.run('UPDATE candidate SET name = $1, description = $2 WHERE candidate_id = $3', [name, description, Number(req.params.id)]);
      if (!result.rowCount) return res.status(404).json({ error: 'Candidate not found.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.put('/admin/candidates/:id/photo', adminOnly, editable, async (req, res, next) => {
    try {
      const id = Number(req.params.id), epoch = await value('election_id');
      if (!await db.one('SELECT 1 FROM candidate WHERE candidate_id = $1', [id])) return res.status(404).json({ error: 'Candidate not found.' });
      const data = req.body.data;
      if (typeof data !== 'string' || data.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return res.status(400).json({ error: 'Choose a JPEG, PNG, or WebP image under 2 MB.' });
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Photo must be under 2 MB.' });
      let image;
      try {
        const input = sharp(bytes, { limitInputPixels: 16000000, failOn: 'warning' });
        const metadata = await input.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error('Unsupported image');
        image = await input.rotate().resize(480, 480, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
      } catch { return res.status(400).json({ error: 'Invalid image. Use a still JPEG, PNG, or WebP up to 16 megapixels.' }); }
      // Decoding is async: recheck close/reset/deletion before committing the image.
      await syncDeadline();
      if (await value('status') === 'closed' || await value('election_id') !== epoch) return res.status(409).json({ error: 'Election changed during upload. Refresh and try again.' });
      const candidate = await db.one('SELECT photo FROM candidate WHERE candidate_id = $1', [id]);
      if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
      fs.mkdirSync(uploadDir, { recursive: true });
      const filename = randomUUID() + '.webp', photo = '/uploads/' + filename;
      fs.writeFileSync(path.join(uploadDir, filename), image);
      try { await db.run('UPDATE candidate SET photo = $1 WHERE candidate_id = $2', [photo, id]); }
      catch (error) { removePhoto(photo); throw error; }
      removePhoto(candidate.photo);
      res.json({ photo });
    } catch (error) { next(error); }
  });
  app.delete('/admin/candidates/:id/photo', adminOnly, editable, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const candidate = await db.one('SELECT photo FROM candidate WHERE candidate_id = $1', [id]);
      if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
      await db.run('UPDATE candidate SET photo = NULL WHERE candidate_id = $1', [id]);
      removePhoto(candidate.photo);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.post('/admin/roster/preview', adminOnly, async (req, res, next) => {
    try {
      if (typeof req.body.csv !== 'string') return res.status(400).json({ error: 'CSV text required.' });
      res.json(await previewRoster(req.body.csv));
    } catch (e) { next(e); }
  });
  app.get('/admin/roster', adminOnly, async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const status = String(req.query.status || 'all');
      const offset = Math.max(0, Math.min(1000000, Number.parseInt(req.query.offset, 10) || 0));
      const filter = status === 'voted' ? 'token_used = 1' : status === 'checked_in' ? 'checked_in = 1 AND token_used = 0' : status === 'eligible' ? 'checked_in = 0 AND token_used = 0' : 'TRUE';
      const like = '%' + q.replace(/[%_\\]/g, (s) => '\\' + s) + '%';
      const where = `WHERE (student_id ILIKE $1 OR COALESCE(name, '') ILIKE $1) AND ${filter}`;
      const total = (await db.one(`SELECT COUNT(*)::int AS n FROM roster ${where}`, [like])).n;
      const rows = await db.query(`SELECT student_id, name, checked_in, token_used FROM roster ${where} ORDER BY student_id LIMIT 50 OFFSET $2`, [like, offset]);
      res.json({ rows, total, offset, limit: 50 });
    } catch (e) { next(e); }
  });
  app.get('/admin/backup', adminOnly, async (req, res, next) => {
    try {
      // Portable JSON row-dump (replaces SQLite VACUUM INTO). Restore re-inserts.
      const tables = {};
      for (const t of ['position', 'candidate', 'roster', 'ballot', 'meta']) tables[t] = await db.query(`SELECT * FROM ${t} ORDER BY 1`);
      const photos = {};
      for (const row of await db.query('SELECT photo FROM candidate WHERE photo IS NOT NULL')) {
        const match = photoName.exec(row.photo);
        if (match) { try { photos[match[1]] = fs.readFileSync(path.join(uploadDir, match[1])).toString('base64'); } catch { /* missing photo */ } }
      }
      res.attachment('election-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json').json({
        format: 'campus-election-backup-v2', created_at: new Date().toISOString(), tables, photos,
      });
    } catch (e) { next(e); }
  });
  app.post('/admin/reset', adminOnly, async (req, res, next) => {
    try {
      const mode = req.body.mode;
      const phrase = mode === 'practice' ? 'RESET PRACTICE VOTES' : mode === 'new' ? 'START NEW ELECTION' : null;
      if (!phrase || req.body.confirmation !== phrase) return res.status(400).json({ error: 'Type the exact confirmation phrase for the selected reset.' });
      if (req.body.election_id !== await value('election_id')) return res.status(409).json({ error: 'Election changed. Refresh before resetting.' });
      const photos = mode === 'new' ? await db.query('SELECT photo FROM candidate') : [];
      await resetElection(mode);
      photos.forEach((c) => removePhoto(c.photo));
      res.json({ ok: true, mode, election_id: await value('election_id') });
    } catch (e) { next(e); }
  });
  app.get('/results.csv', async (req, res, next) => {
    try {
      if (await value('status') !== 'closed') return res.status(409).json({ error: 'Results are available after polls close.' });
      const t = await tally(), v = await verifyChain();
      const rows = [['Election', await value('title') || 'Campus Election'], ['Total ballots', t.total], ['Approved by', await value('approved_by') || 'Awaiting approval'], ['Approved at', await value('approved_at') || ''], ['Verification', v.ok ? 'PASSED' : 'FAILED'], ['Audit root', await value('root') || ''], [], ['Position', 'Outcome', 'Candidate ID', 'Candidate', 'Description', 'Active', 'Votes']];
      for (const p of t.positions) {
        for (const c of p.results) rows.push([p.title, p.status, c.candidate_id, c.name, c.description, c.active ? 'Yes' : 'No', c.votes]);
        rows.push([p.title, p.status, '', 'Not interested', '', '', p.not_interested]);
      }
      res.attachment('election-results.csv').type('text/csv').send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
    } catch (e) { next(e); }
  });
};
module.exports.editable = editable;
module.exports.removePhoto = removePhoto;

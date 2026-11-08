const db = require('./db');
const emailRe = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

// CSV: student_id, name, and an OPTIONAL email as a trailing field. Quoted
// names and an optional header are supported. Email enables ballot-by-email.
// Async: it reads existing IDs once to flag new/existing rows.
async function previewRoster(csvText) {
  const existing = new Set((await db.query('SELECT student_id FROM roster')).map((r) => r.student_id));
  const rows = [], errors = [], seen = new Set();
  const lines = csvText.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = []; let field = '', quoted = false;
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === '"') {
        if (quoted && lines[i][j + 1] === '"') { field += '"'; j++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) { fields.push(field.trim()); field = ''; }
      else field += ch;
    }
    fields.push(field.trim());
    if (fields[0].toLowerCase() === 'student_id' && fields[1]?.toLowerCase() === 'name') continue;
    // A trailing email field (if the last cell looks like an address) is split
    // off; everything between the ID and it is the name.
    // Optional trailing fields: a level (plain integer 1-100) then an email.
    // Formats supported: id,name | id,name,email | id,name,level | id,name,email,level
    let email = null, level = null, nameFields = fields.slice(1);
    if (nameFields.length > 1 && /^\d{1,3}$/.test(nameFields[nameFields.length - 1])) {
      const n = Number(nameFields[nameFields.length - 1]);
      if (n >= 1 && n <= 100) { level = n; nameFields.pop(); }
    }
    if (nameFields.length > 1 && emailRe.test(nameFields[nameFields.length - 1])) {
      email = nameFields.pop();
    }
    const student_id = fields[0], name = nameFields.join(',').trim();
    if (quoted || !student_id || student_id.length > 100 || name.length > 200 || (email && email.length > 254)) {
      errors.push({ line: i + 1, error: 'Check quotes and field lengths (ID: 100, name: 200, email: 254 characters).' });
      continue;
    }
    const status = seen.has(student_id) ? 'duplicate' : existing.has(student_id) ? 'existing' : 'new';
    seen.add(student_id);
    rows.push({ line: i + 1, student_id, name, email, level, status });
  }
  return { rows, errors, added: rows.filter((r) => r.status === 'new').length,
    skipped: rows.filter((r) => r.status !== 'new').length };
}

async function importRoster(csvText) {
  const preview = await previewRoster(csvText);
  if (preview.errors.length) throw new Error('Fix invalid CSV rows before importing.');
  return db.tx(async (c) => {
    for (const row of preview.rows) {
      // Upsert: new rows inserted; existing rows get their level set/updated (name/email kept).
      await c.query('INSERT INTO roster (student_id, name, email, level) VALUES ($1, $2, $3, $4) ON CONFLICT (student_id) DO UPDATE SET level = COALESCE(EXCLUDED.level, roster.level)', [row.student_id, row.name || null, row.email || null, row.level ?? null]);
    }
    return preview.rows.filter((r) => r.status === 'new').length;
  });
}

module.exports = { importRoster, previewRoster };

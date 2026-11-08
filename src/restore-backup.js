// Restore a v2 JSON backup into a FRESH Postgres schema; never touch a live one.
// The backup is a row-dump ({ tables: {candidate,roster,ballot,meta}, photos }),
// so restore = create schema -> DDL -> re-insert rows -> write photos to a dir.
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { DDL } = require('./db');

const q = (id) => '"' + id.replace(/"/g, '""') + '"';
const IDENTITY = new Set(['position', 'candidate', 'ballot']); // tables with GENERATED ALWAYS columns

async function insertRows(client, table, rows) {
  for (const row of rows) {
    const cols = Object.keys(row);
    if (!cols.length) continue;
    const vals = cols.map((c) => row[c]);
    const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
    const over = IDENTITY.has(table) ? 'OVERRIDING SYSTEM VALUE ' : '';
    const onConflict = table === 'meta' ? ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value' : '';
    await client.query(`INSERT INTO ${table} (${cols.map(q).join(',')}) ${over}VALUES (${ph})${onConflict}`, vals);
  }
}

// Keep identity sequences ahead of the restored max so future inserts don't collide.
async function bumpSequence(client, table, col) {
  await client.query(
    `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX(${q(col)}),0) FROM ${table}), 1))`,
    [table, col],
  );
}

// opts: { url, schema, uploadDir }. url defaults to DATABASE_URL.
async function restore(archiveFile, { url = process.env.DATABASE_URL, schema, uploadDir } = {}) {
  if (!url) throw new Error('No DATABASE_URL (pass opts.url).');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema || '')) throw new Error('Invalid schema name.');
  if (!uploadDir) throw new Error('uploadDir is required.');

  const archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
  if (archive.format !== 'campus-election-backup-v2' || !archive.tables || typeof archive.tables !== 'object'
      || !archive.photos || typeof archive.photos !== 'object' || Array.isArray(archive.photos)) {
    throw new Error('Unsupported backup format.');
  }
  for (const t of ['position', 'candidate', 'roster', 'ballot', 'meta']) {
    if (!Array.isArray(archive.tables[t])) throw new Error('Backup is missing table: ' + t);
  }
  // Validate photos up front so an unsafe archive leaves no schema behind.
  const photos = Object.entries(archive.photos).map(([name, data]) => {
    if (!/^[a-f0-9-]+\.webp$/.test(name) || typeof data !== 'string') throw new Error('Invalid photo entry in backup.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WEBP') throw new Error('Invalid WebP in backup.');
    return [name, bytes];
  });
  for (const row of archive.tables.candidate) {
    if (row.photo != null && (!/^\/uploads\/[a-f0-9-]+\.webp$/.test(row.photo) || !Object.hasOwn(archive.photos, path.basename(row.photo)))) {
      throw new Error('A candidate photo is missing from the backup.');
    }
  }

  const scopedUrl = url + (url.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c search_path=' + schema);
  const ssl = /supabase|amazonaws|render/.test(url) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: scopedUrl, ssl });
  const client = await pool.connect();
  try {
    const exists = await client.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema]);
    if (exists.rowCount) throw new Error('Destination schema already exists. Choose a new name; existing data will not be overwritten.');
    await client.query(`CREATE SCHEMA ${q(schema)}`);
    await client.query(DDL);
    await client.query('BEGIN');
    await insertRows(client, 'position', archive.tables.position);
    await insertRows(client, 'candidate', archive.tables.candidate);
    await insertRows(client, 'roster', archive.tables.roster);
    await insertRows(client, 'ballot', archive.tables.ballot);
    await insertRows(client, 'meta', archive.tables.meta);
    await bumpSequence(client, 'position', 'position_id');
    await bumpSequence(client, 'candidate', 'candidate_id');
    await bumpSequence(client, 'ballot', 'seq');
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  fs.mkdirSync(uploadDir, { recursive: true });
  for (const [name, data] of photos) fs.writeFileSync(path.join(uploadDir, name), data, { flag: 'wx' });
  return schema;
}

if (require.main === module) {
  (async () => {
    try {
      if (process.argv.length !== 4) throw new Error('Usage: node restore-backup.js <backup.json> <new-schema>  (env: DATABASE_URL, UPLOAD_DIR)');
      const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
      const schema = await restore(process.argv[2], { schema: process.argv[3], uploadDir });
      console.log('Restored into schema:', schema, '| photos ->', uploadDir);
      console.log('Point the server at this schema (DATABASE_URL ...?options=-c search_path=' + schema + ') and keep the matching KEY_DIR/PRIVATE_KEY_PEM. Do not regenerate signing keys for a restored election.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  })();
}
module.exports = { restore };

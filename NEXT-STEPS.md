# Next steps — Supabase Postgres migration

Handoff for a fresh session. The app has been migrated from local `node:sqlite`
to **Supabase Postgres**. The voting critical path is smoke-tested and working.
This file lists what's DONE and what's LEFT, with exact files and commands.

---

## Current state (DONE)

- Whole data layer rewritten **async** on `pg` (node-postgres). Files in `src/`:
  `db.js, crypto.js, cast.js, checkin.js, roster.js, election.js, tally.js,
  verify.js, management.js, server.js`.
- Postgres schema created in Supabase: `candidate, roster, ballot, meta`
  (+ `ballot.seq` identity column for chain ordering).
- Integrity preserved: ballot casts run in `db.tx(fn, { lock: true })`, which
  takes `pg_advisory_xact_lock` so concurrent casts serialize and the hash chain
  can't fork. **Smoke-verified: 20 concurrent votes, chain intact, tally+verify ok.**
- Signing key: public key stored in `meta` (DB); private key in `keys/` file OR
  `PRIVATE_KEY_PEM` env. Backup endpoint now emits **JSON v2** row-dump.

### New data-layer API (how db.js is used now)
```
const db = require('./db');
await db.query(sql, params)   // -> array of rows
await db.one(sql, params)     // -> first row or null
await db.run(sql, params)     // -> { rowCount, rows }
await db.tx(async (c) => {...}, { lock: true })   // transaction; lock for chain writes
await db.init()               // create schema (called on server start)
```
SQL uses `$1,$2…` placeholders, `ON CONFLICT`, `RETURNING`, `ILIKE`, `::int` casts.

---

## LEFT TO DO (tackle in the new session, in this order)

### 1. Port the test suite to Postgres  — ✅ DONE
`test/election.test.js` now isolates each test in its own **Postgres schema**:
`boot()` generates `test_<rand>`, `CREATE SCHEMA`, and the spawned server lands
there via a connection-string `options=-c search_path=<schema>` param (verified).
Direct DB assertions use `e.pool` (a pg Pool scoped to the schema) instead of
`DatabaseSync`; `stop()` is async — `DROP SCHEMA ... CASCADE` + `pool.end()`.
Tests reuse the live `DATABASE_URL` (throwaway schemas keep `public` untouched).
`test/frontend.test.js` unchanged. **All 33 tests green.**
- Parity fix in `src/election.js`: `resetElection('new')` now
  `ALTER TABLE candidate ... RESTART WITH 1` — SQLite reused ids from 1 after
  delete-all; Postgres identity doesn't, and a test/UI expects a clean slate.

### 2. Update restore-backup.js for backup v2  — ✅ DONE
`src/restore-backup.js` rewritten: `restore(archiveFile, { url, schema, uploadDir })`
validates the v2 archive + photos, `CREATE SCHEMA`, runs the shared `DDL` (now
exported from `db.js`), re-inserts rows (`OVERRIDING SYSTEM VALUE` for identity
tables, `ON CONFLICT` for meta), bumps identity sequences, and writes photos to
`uploadDir`. Refuses an existing schema; CLI: `node src/restore-backup.js <backup.json> <schema>`.

### 3. Deployment config  (MEDIUM)
The DB is now external (Supabase), so a persistent disk is no longer required
for the database — only for `keys/` and `uploads/` (and those can move to env /
Storage, see item 4).
- **render.yaml**: remove the DB-on-disk assumption; add `DATABASE_URL` and
  `PRIVATE_KEY_PEM` env vars. Keep a small disk only if photos stay on disk.
- **Vercel is now viable** (DB is external): wrap `src/server.js` as a serverless
  function + `vercel.json`, set `DATABASE_URL` to the Supabase **pooler** host
  (`...pooler.supabase.com:6543`, transaction mode) not the direct 5432, set
  `PRIVATE_KEY_PEM`, and do item 4 (photos → Storage, since serverless has no disk).
- Host env vars needed: `DATABASE_URL`, `ADMIN_KEY`, `OPERATOR_KEY`, `BASE_URL`,
  `PRIVATE_KEY_PEM`, and SMTP_* (see `.env.example`).
- Get the private key for env: `PRINT_PRIVATE_KEY=1 node --env-file=.env src/crypto.js keygen`.

### 4. Candidate photos → Supabase Storage  (LOW — only needed for diskless/Vercel)
Photos currently write to the local `uploads/` dir (fine on Render with a disk).
For Vercel/serverless, move them to a Supabase **Storage bucket**:
- Create a public bucket (e.g. `candidate-photos`).
- In `src/management.js`, replace the `fs.writeFileSync`/`removePhoto` disk calls
  with Storage upload/delete (supabase-js `storage.from(bucket)`), and store the
  public URL in `candidate.photo` instead of `/uploads/...`.
- Update backup to reference Storage URLs.

---

## Security — DO BEFORE GOING LIVE
These are exposed in the build chat / `.env` and must be rotated:
- **Supabase DB password** — Project Settings → Database → Reset password, then
  update `DATABASE_URL`.
- **Supabase access token** (in `.env`) — revoke + reissue.
- **Gmail password** — change it; use a 16-char **App Password** for SMTP, not
  the account password (the account password does not authenticate anyway).

## Quick reference
- Run locally: `npm start` (reads `.env`; needs `DATABASE_URL`).
- Keygen: `node --env-file=.env src/crypto.js keygen` (stores public key in meta).
- Env template: `.env.example`. Data/CSVs + round guide: `data/`.
- Smoke pattern (critical path) is in this session's history if you need to re-run one.

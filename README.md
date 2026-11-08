# Campus Election

A small Express application using SQLite, local candidate photos, and signed ballots. No external database or storage service is required.

## Run

Use a Node version with `node:sqlite` (the project is tested with the installed Node runtime).

1. Run `npm install` (`npm.cmd install` in Windows PowerShell if script execution is disabled).
2. Copy `.env.example` to `.env` if you do not already have one. Set distinct operator and admin keys.
3. On a **new installation only**, run `npm run keygen`. Do not regenerate keys for an election with existing ballots.
4. Run `npm start` and open `http://localhost:3000`.

Existing databases gain the optional candidate photo column automatically. Existing ballots and voter data are retained.

## Run an election

- **Admin:** sign in, set the title and optional deadline, add/edit candidates, and upload candidate photos. JPEG, PNG, and WebP are supported, up to 2 MB and 16 megapixels. The server validates, crops, and re-encodes photos to 480px square WebP, removing metadata. No photo shows initials instead.
- **Roster:** paste `student_id,name` rows or load a CSV file, preview the proposed import, fix invalid rows, then import. An optional header and quoted names are supported. Existing and duplicate IDs are skipped. Search by ID/name and filter participation status; ballot choices are never part of the roster response.
- **Voting station:** operator checks in the student, hands over the screen, then the voter selects a candidate, reviews the choice, and explicitly casts the ballot.
- **Interrupted submission:** the screen reports an unknown outcome rather than claiming success/failure. The operator checks the student in again. A recorded ballot blocks another vote; an uncast token can be replaced.
- **Closing:** manual closing or the scheduled deadline closes the election. Deadline state is synchronized on the next API request; ballot and check-in code also enforce the deadline. Candidate/roster/setup changes are then locked. An official can approve a verified, nonempty, nontied result.
- **Results:** refresh automatically every five seconds while visible. After closing, download CSV or print the result sheet, including approval and verification information. Before approval, results are explicitly marked as awaiting approval.
- **Sign out:** use the admin toolbar on shared computers. The admin key is removed from session storage.

## Backup and reset

In Admin, use **Backup & reset**:

1. Download an election backup and check that it was saved. This JSON archive contains a standalone SQLite snapshot (including committed WAL data) and candidate photos. It contains the private voter roster and should be stored privately. It deliberately excludes the private signing key; keep the matching `keys` folder separately.
2. Choose a reset mode:
   - **Reset practice votes:** clears ballots, voter participation/tokens, deadline, audit root, and approval. Keeps candidates, their active/withdrawn status, photos, roster, title, and description.
   - **Start new election:** additionally clears candidates, photos, roster, title, and description.
3. Acknowledge the backup choice and type the displayed confirmation phrase.

Both modes run database changes in one transaction, preserve the signing key and public-key record, invalidate old tokens, and reopen voting. A stale admin tab cannot repeat a reset against a different election generation. No reset runs automatically during installation or startup.

## Restore a backup

Stop the server before switching datasets. Restore to a **new folder**, never over a live database:

```powershell
node restore-backup.js "C:\path\election-backup.json" "D:\Voting\restored-election"
```

Set these paths in `.env` and restart:

```text
DB_FILE=D:/Voting/restored-election/election.db
UPLOAD_DIR=D:/Voting/restored-election/uploads
KEY_DIR=D:/Voting/keys
```

`KEY_DIR` must contain the original matching signing key. Do not run key generation over a restored election. The restore tool refuses an existing destination and rejects unsafe photo filenames. If an invalid archive leaves a partial output folder, choose a new folder after correcting the archive.

By default, uploads live in an `uploads` folder beside the configured database. Reset and candidate-photo removal delete only files referenced by the affected candidates. Avoid manually deleting the database or its WAL files while the server is running.

## Verification and tests

`npm test` runs real HTTP integration tests against temporary databases and keys, plus frontend behavior tests. It does not clear the working election.

Verification checks ballot hashes, signatures, insertion order, the stored chain tip, and the pinned root after closing. This detects a truncated chain as well as changed ballots. It is an integrity check against stored records, not protection against an administrator who can replace the database and signing keys together.

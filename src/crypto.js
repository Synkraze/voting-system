// ed25519 via Node stdlib only. No hand-rolled curve math.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_DIR = process.env.KEY_DIR || path.join(__dirname, '..', 'keys');
const PRIV_PATH = path.join(KEY_DIR, 'server_ed25519.pem');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Fixed-field canonical string so signatures/hashes are stable. Includes the
// position and the choice; a null candidate_id (the "not interested" option)
// canonicalizes to NOTA so abstentions are chained and verifiable like any vote.
function ballotBytes(b) {
  return `${b.ballot_id}|${b.position_id}|${b.candidate_id ?? 'NOTA'}|${b.created_at}|${b.prev_hash}`;
}

// Production ballots were cast with this single-hash form (verified empirically
// against the live chain). ballotBytes already embeds prev_hash, so the chain is
// fully linked. Do NOT change this — it would invalidate every existing ballot.
function chainHash(b) {
  return sha256(ballotBytes(b));
}

// Serverless/Supabase: the key lives in the PRIVATE_KEY_PEM env var. Local/disk
// deploys fall back to the pem file.
function loadPrivateKey() {
  if (process.env.PRIVATE_KEY_PEM) return crypto.createPrivateKey(process.env.PRIVATE_KEY_PEM);
  return crypto.createPrivateKey(fs.readFileSync(PRIV_PATH));
}

// Public key is stored in the DB (meta). Async now that the DB is networked.
async function publicKeyPem(db) {
  const row = await db.one('SELECT value FROM meta WHERE key = $1', ['public_key']);
  if (!row) throw new Error('No public key in meta. Run: npm run keygen');
  return row.value;
}

function sign(msg) {
  return crypto.sign(null, Buffer.from(msg), loadPrivateKey()).toString('hex');
}

function verify(msg, sigHex, pubPem) {
  return crypto.verify(null, Buffer.from(msg), crypto.createPublicKey(pubPem), Buffer.from(sigHex, 'hex'));
}

function token() {
  return crypto.randomBytes(32).toString('hex');
}

function ballotId() {
  return crypto.randomBytes(16).toString('hex');
}

// CLI: npm run keygen -> writes the public key into meta, and the private key to
// a pem file (unless PRIVATE_KEY_PEM is already set). PRINT_PRIVATE_KEY=1 echoes
// the private pem so you can paste it into an env var for serverless hosts.
async function keygen() {
  const db = require('./db');
  await db.init();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  if (!process.env.PRIVATE_KEY_PEM) {
    if (!fs.existsSync(KEY_DIR)) fs.mkdirSync(KEY_DIR, { recursive: true });
    fs.writeFileSync(PRIV_PATH, privPem);
  }
  await db.run('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['public_key', pubPem]);
  console.log('Keypair generated. Public key stored in meta (database).');
  if (process.env.PRINT_PRIVATE_KEY) console.log('\nPRIVATE_KEY_PEM (set this env var on your host):\n' + privPem);
  else console.log('Private key:', PRIV_PATH, '- BACK IT UP OFFLINE.');
  await db.pool.end();
}

if (require.main === module && process.argv[2] === 'keygen') keygen().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { sha256, ballotBytes, chainHash, sign, verify, token, ballotId, publicKeyPem };

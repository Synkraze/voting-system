// Authentication for both audiences, stdlib only (no bcrypt/jwt deps):
//   - Admins: username + scrypt password hash in admin_user; stateless signed
//     session tokens (reuse the ed25519 server key).
//   - Voters: email + one-time OTP (hashed + expiring on the roster row). The
//     post-OTP vote session reuses the existing roster.token_hash mechanism.
const crypto = require('crypto');
const db = require('./db');
const { sign, verify, publicKeyPem } = require('./crypto');

// --- Password hashing (scrypt) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const dk = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}
// Run even on unknown users so login time doesn't reveal whether a user exists.
const DUMMY_HASH = hashPassword('invalid-placeholder-password');

// --- Admin accounts ---
async function createAdmin(username, password) {
  username = String(username || '').trim().toLowerCase();
  if (!username || username.length > 64) throw new Error('Username required (max 64 characters).');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  await db.run(
    'INSERT INTO admin_user (username, password_hash, created_at) VALUES ($1, $2, $3) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash',
    [username, hashPassword(password), Date.now()]
  );
  return { username };
}

async function authenticateAdmin(username, password) {
  username = String(username || '').trim().toLowerCase();
  const row = await db.one('SELECT username, password_hash FROM admin_user WHERE username = $1', [username]);
  const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return null;
  return issueSession(username);
}

async function seedAdminFromEnv() {
  const u = process.env.ADMIN_USER, p = process.env.ADMIN_PASS;
  if (!u || !p) return;
  if ((await db.one('SELECT COUNT(*)::int AS n FROM admin_user')).n > 0) return;
  await createAdmin(u, p);
  console.log(`Seeded admin "${String(u).trim().toLowerCase()}" from ADMIN_USER/ADMIN_PASS.`);
}

// --- Stateless admin sessions (ed25519-signed) ---
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
function issueSession(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
async function readSession(tok) {
  const [payload, sig] = String(tok || '').split('.');
  if (!payload || !sig) return null;
  let pub;
  try { pub = await publicKeyPem(db); } catch { return null; }
  try { if (!verify(payload, sig, pub)) return null; } catch { return null; }
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || typeof data.exp !== 'number' || Date.now() >= data.exp) return null;
  return { username: data.u };
}
// Express middleware: gate admin routes on a valid session token.
function adminSession(req, res, next) {
  const header = req.get('authorization') || '';
  const tok = header.startsWith('Bearer ') ? header.slice(7) : (req.get('x-admin-token') || '');
  readSession(tok).then((s) => {
    if (!s) return res.status(401).json({ error: 'unauthorized' });
    req.admin = s;
    next();
  }).catch(next);
}

// --- Voter OTP ---
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
// Bind the hash to the email so a leaked hash can't be replayed on another row.
function hashOtp(email, otp) {
  return crypto.createHash('sha256').update(String(email).toLowerCase() + '|' + String(otp)).digest('hex');
}

if (require.main === module) {
  const [cmd, u, p] = process.argv.slice(2);
  (async () => {
    if (cmd !== 'create-admin' || !u || !p) {
      console.error('Usage: node src/auth.js create-admin <username> <password>');
      process.exit(1);
    }
    await db.init();
    await createAdmin(u, p);
    console.log('Admin created:', String(u).trim().toLowerCase());
    await db.pool.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = {
  hashPassword, verifyPassword, createAdmin, authenticateAdmin, seedAdminFromEnv,
  issueSession, readSession, adminSession,
  generateOtp, hashOtp, OTP_TTL_MS, OTP_MAX_ATTEMPTS,
};

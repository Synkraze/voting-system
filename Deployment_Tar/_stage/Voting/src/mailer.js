// SMTP delivery of voter one-time codes (OTP). Transport is built from env the
// same way the keys are: nothing is hard-coded. If SMTP isn't configured the
// request-OTP endpoint refuses up front.
const nodemailer = require('nodemailer');

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

let transport = null;
function getTransport() {
  if (!smtpConfigured()) throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_FROM (and SMTP_USER/SMTP_PASS if your server needs auth) in .env.');
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true', // true for 465, false for 587 (STARTTLS)
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function otpEmail({ to, name, otp, title, ttlMin }) {
  const who = name ? name.split(/\s+/)[0] : 'there';
  const safeTitle = title || 'Campus Election';
  const text = `Hi ${who},\n\nYour voting code for ${safeTitle} is:\n\n${otp}\n\nEnter it on the voting page to open your private ballot. The code expires in ${ttlMin} minutes and works once. If you did not request this, ignore this email.\n`;
  const html = `<p>Hi ${esc(who)},</p><p>Your voting code for <strong>${esc(safeTitle)}</strong> is:</p><p style="font-size:2rem;font-weight:700;letter-spacing:.3em;margin:.6rem 0">${esc(otp)}</p><p>Enter it on the voting page to open your private ballot. The code expires in ${esc(ttlMin)} minutes and works once.</p><p style="color:#666;font-size:.9em">If you did not request this, ignore this email.</p>`;
  return { from: process.env.SMTP_FROM, to, subject: `Your voting code — ${safeTitle}`, text, html };
}

// Send one OTP. Throws on delivery failure so the caller can roll back the code.
async function sendOtp({ to, name, otp, title, ttlMin }) {
  await getTransport().sendMail(otpEmail({ to, name, otp, title, ttlMin }));
}

module.exports = { smtpConfigured, sendOtp };

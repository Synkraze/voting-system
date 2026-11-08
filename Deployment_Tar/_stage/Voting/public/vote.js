// Voter flow, one page: email -> OTP -> multi-position ballot -> done.
const $ = id => document.getElementById(id);
let token = null, email = '', positions = [], selections = {}, submitting = false;
function flash(el, type, text) { el.className = 'msg show ' + type; el.textContent = text; }
const post = (url, body) => UI.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function show(id) {
  for (const card of ['emailCard', 'otpCard', 'ballotCard', 'doneCard']) $(card).style.display = card === id ? 'block' : 'none';
}

async function requestOtp() {
  if ($('otpReqBtn').disabled) return;
  const e = $('email').value.trim().toLowerCase();
  if (!e) return flash($('emailMsg'), 'err', 'Enter your email address.');
  $('otpReqBtn').disabled = true;
  try {
    const r = await post('/voter/request-otp', { email: e });
    if (!r.ok) return flash($('emailMsg'), 'err', r.data.error || 'Could not send a code. Try again.');
    email = e; $('otpEmailLabel').textContent = e; $('otp').value = '';
    show('otpCard'); $('otp').focus();
    flash($('otpMsg'), 'ok', r.data.message || 'If that email is eligible, a code is on its way.');
  } finally { $('otpReqBtn').disabled = false; }
}

async function verifyOtp() {
  if ($('otpBtn').disabled) return;
  const code = $('otp').value.trim();
  if (!code) return flash($('otpMsg'), 'err', 'Enter the code from your email.');
  $('otpBtn').disabled = true;
  try {
    const r = await post('/voter/verify-otp', { email, otp: code });
    if (!r.ok || !r.data.token) return flash($('otpMsg'), 'err', r.data.error || 'Invalid or expired code.');
    token = r.data.token;
    await showBallot();
  } finally { $('otpBtn').disabled = false; }
}

function backToEmail() { token = null; email = ''; show('emailCard'); $('email').focus(); }

async function showBallot() {
  selections = {}; submitting = false; $('ballotMsg').className = 'msg';
  const r = await UI.request('/positions');
  if (!r.ok || !r.data.length) {
    token = null;
    return flash($('otpMsg'), 'err', r.ok ? 'There are no positions to vote on yet. Contact the election office.' : 'Could not load the ballot. Please try again.');
  }
  positions = r.data;
  const el = $('ballotList');
  el.replaceChildren();
  for (const p of positions) {
    const group = document.createElement('fieldset');
    group.className = 'card ballot-position';
    group.innerHTML = `<legend><h2>${UI.escape(p.title)}</h2></legend><div class="ballot" id="pos-${p.position_id}"></div>`;
    el.append(group);
    const list = group.querySelector('#pos-' + p.position_id);
    for (const c of p.candidates) list.append(optionButton(p, c));
    list.append(optionButton(p, null)); // "Not interested" on every position
  }
  updateSubmit();
  show('ballotCard');
  window.scrollTo(0, 0);
}

function optionButton(p, c) {
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('aria-pressed', 'false');
  const nota = c === null;
  const name = nota ? 'Not interested' : c.name;
  const desc = nota ? 'Do not support any candidate for this position.' : (c.description || '');
  b.innerHTML = (nota ? '' : UI.portrait(c)) + `<span class="candidate-name">${UI.escape(name)}</span><span class="sub">${UI.escape(desc)}</span><span class="selection-label">Select</span>`;
  b.onclick = () => {
    selections[p.position_id] = nota ? null : c.candidate_id;
    const list = $('pos-' + p.position_id);
    for (const other of list.children) {
      const on = other === b;
      other.setAttribute('aria-pressed', String(on));
      other.querySelector('.selection-label').textContent = on ? 'Selected' : 'Select';
    }
    updateSubmit();
  };
  return b;
}

function updateSubmit() {
  const chosen = positions.filter(p => Object.prototype.hasOwnProperty.call(selections, p.position_id)).length;
  $('castBtn').disabled = chosen !== positions.length || submitting;
  $('ballotProgress').textContent = chosen + ' of ' + positions.length + ' positions selected';
}

async function vote() {
  if (submitting || $('castBtn').disabled || !token) return;
  if (!confirm('Cast your ballot? Your choices cannot be changed after this.')) return;
  submitting = true; $('castBtn').disabled = true;
  const tok = token; token = null;
  const payload = positions.map(p => ({ position_id: p.position_id, candidate_id: selections[p.position_id] ?? null }));
  const r = await post('/vote', { token: tok, selections: payload });
  if (!r.ok || !r.data.ok) {
    submitting = false;
    if (r.data.code === 'HELD') token = tok;
    return flash($('ballotMsg'), 'err', r.uncertain
      ? 'Submission status is unknown. Request a new code to check — if your ballot was recorded, a second attempt is blocked.'
      : (r.data.error || 'Could not record your ballot. Request a new code and try again.'));
  }
  show('doneCard'); $('doneCard').querySelector('button')?.focus();
  if (window.confetti) confetti();
}

function restart() { token = null; email = ''; selections = {}; positions = []; show('emailCard'); $('email').value = ''; $('email').focus(); }

$('email').addEventListener('keydown', e => { if (e.key === 'Enter') requestOtp(); });
$('otp').addEventListener('keydown', e => { if (e.key === 'Enter') verifyOtp(); });

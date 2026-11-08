// Voter flow, one page: email -> OTP -> multi-position ballot -> done.
const $ = id => document.getElementById(id);
let token = null, email = '', positions = [], selections = {}, submitting = false;
let statusTimer = null, votingClosed = false;
function flash(el, type, text) { el.className = 'msg show ' + type; el.textContent = text; }
const post = (url, body) => UI.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function show(id) {
  for (const card of ['consentCard', 'emailCard', 'otpCard', 'ballotCard', 'doneCard']) $(card).style.display = card === id ? 'block' : 'none';
}

async function requestOtp() {
  if ($('otpReqBtn').disabled) return;
  const e = $('email').value.trim().toLowerCase();
  if (!e) return flash($('emailMsg'), 'err', 'Enter your email address.');
  $('otpReqBtn').disabled = true;
  try {
    const r = await post('/voter/request-otp', { email: e });
    if (!r.ok) {
      if (r.data.code === 'ALREADY_VOTED') {
        window.alert('Already voted. You have already cast your ballot.');
        $('email').focus();
        return;
      }
      return flash($('emailMsg'), 'err', r.data.error || 'Could not send a code. Try again.');
    }
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

function backToEmail() { stopStatusPoll(); token = null; email = ''; show('emailCard'); $('email').focus(); }

async function showBallot() {
  selections = {}; submitting = false; votingClosed = false; $('ballotMsg').className = 'msg';
  // Token-scoped ballot: only the positions this voter's level is eligible for.
  const r = await post('/ballot', { token });
  if (!r.ok || !r.data.length) {
    token = null;
    return flash($('otpMsg'), 'err', r.ok ? 'There are no positions on your ballot. Contact the election office.' : 'Could not load the ballot. Please try again.');
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
    if (!p.candidates.length) {
      const empty = document.createElement('p');
      empty.className = 'sub';
      empty.textContent = 'No candidates are listed for this position. Contact the election office.';
      list.append(empty);
    }
  }
  updateSubmit();
  show('ballotCard');
  window.scrollTo(0, 0);
  startStatusPoll();
}

// Voting can close (deadline or admin) while a ballot sits open. Poll the public
// status and lock the ballot the moment it is no longer open, so the voter finds
// out before wasting a submission. Re-enables if voting resumes from a hold.
function startStatusPoll() {
  clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    const r = await UI.request('/info');
    if (!r.ok || !r.data.status) return;
    const open = r.data.status === 'open';
    if (!open && !votingClosed) {
      votingClosed = true; updateSubmit();
      flash($('ballotMsg'), 'err', r.data.status === 'held'
        ? 'Voting has been paused. You cannot submit until it resumes.'
        : 'Voting has closed. This ballot can no longer be submitted.');
      if (r.data.status === 'closed') stopStatusPoll();
    } else if (open && votingClosed) {
      votingClosed = false; $('ballotMsg').className = 'msg'; updateSubmit();
    }
  }, 15000);
}
function stopStatusPoll() { clearInterval(statusTimer); statusTimer = null; }

function optionButton(p, c) {
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('aria-pressed', 'false');
  b.innerHTML = UI.portrait(c) + `<span class="candidate-name">${UI.escape(c.name)}</span><span class="sub">${UI.escape(c.description || '')}</span><span class="selection-label">Select</span>`;
  b.onclick = () => {
    const wasSelected = selections[p.position_id] === c.candidate_id;
    if (wasSelected) delete selections[p.position_id];
    else selections[p.position_id] = c.candidate_id;
    const list = $('pos-' + p.position_id);
    for (const other of list.children) {
      const on = other === b && !wasSelected;
      other.setAttribute('aria-pressed', String(on));
      other.querySelector('.selection-label').textContent = on ? 'Selected' : 'Select';
    }
    updateSubmit();
  };
  return b;
}

function updateSubmit() {
  const chosen = positions.filter(p => Object.prototype.hasOwnProperty.call(selections, p.position_id)).length;
  $('castBtn').disabled = votingClosed || chosen === 0 || submitting;
  $('ballotProgress').textContent = chosen + ' of ' + positions.length + ' positions selected';
}

async function vote() {
  if (submitting || $('castBtn').disabled || !token) return;
  const skipped = positions.length - Object.keys(selections).length;
  if (!confirm(`Cast your vote for the selected positions?${skipped ? ` ${skipped} unselected position${skipped === 1 ? '' : 's'} will be recorded as "Not interested".` : ''} Once submitted, your selection cannot be changed.`)) return;
  submitting = true; $('castBtn').disabled = true;
  const tok = token; token = null;
  const payload = positions.map(p => ({ position_id: p.position_id, candidate_id: selections[p.position_id] ?? null }));
  const r = await post('/vote', { token: tok, selections: payload });
  if (!r.ok || !r.data.ok) {
    submitting = false;
    // Ballot changed under the voter: a candidate was withdrawn/removed, or a
    // position was added/removed by the election office between load and submit.
    // The token is NOT burned on a validation failure (cast.js validates before
    // marking it used), so restore it, reload the live ballot, and let them
    // re-choose rather than dead-ending with a generic error.
    if (r.data.code === 'BADCANDIDATE' || r.data.code === 'INCOMPLETE') {
      token = tok;
      await showBallot();
      return flash($('ballotMsg'), 'err', 'The ballot was updated by the election office. Please review the choices and submit again.');
    }
    if (r.data.code === 'HELD') token = tok;
    return flash($('ballotMsg'), 'err', r.uncertain
      ? 'Submission status is unknown. Request a new code to check — if your ballot was recorded, a second attempt is blocked.'
      : (r.data.error || 'Could not record your ballot. Request a new code and try again.'));
  }
  stopStatusPoll();
  show('doneCard'); $('doneCard').querySelector('button')?.focus();
  if (window.confetti) confetti();
}

function restart() { stopStatusPoll(); token = null; email = ''; selections = {}; positions = []; $('email').value = ''; show('consentCard'); loadConsent(); }

// Consent gate: render the declaration points as required checkboxes; sign-in
// stays hidden until all are ticked.
async function loadConsent() {
  const r = await UI.request('/info');
  const points = (r.ok && r.data.consent && r.data.consent.points) || [];
  const el = $('consentList');
  el.replaceChildren();
  points.forEach((p) => {
    const label = document.createElement('label');
    label.className = 'check-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', updateConsent);
    const span = document.createElement('span');
    span.textContent = p;
    label.append(cb, span);
    el.append(label);
  });
  updateConsent();
}
function consentBoxes() { return [...$('consentList').querySelectorAll('input[type=checkbox]')]; }
function updateConsent() {
  const boxes = consentBoxes();
  $('consentBtn').disabled = !(boxes.length > 0 && boxes.every((b) => b.checked));
}
function acceptConsent() {
  const boxes = consentBoxes();
  if (!boxes.length || !boxes.every((b) => b.checked)) return;
  show('emailCard'); $('email').focus();
}

$('email').addEventListener('keydown', e => { if (e.key === 'Enter') requestOtp(); });
$('otp').addEventListener('keydown', e => { if (e.key === 'Enter') verifyOtp(); });
show('consentCard');
loadConsent();

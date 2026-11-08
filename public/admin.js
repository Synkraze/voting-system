
const $ = (id) => document.getElementById(id);
let TOKEN = sessionStorage.getItem('admintoken') || '';
let timer = null;
let authVersion = 0;
let electionId = null, electionClosed = false, candidateList = [], positionList = [], editingId = null;
let reviewedCsv = '', rosterOffset = 0, rosterRequest = 0;

function flash(el, type, text) { el.className = 'msg show ' + type; el.textContent = text; }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function api(method, url, body) {
  const tok = TOKEN;
  const version = authVersion;
  if (!tok) return { ok: false, status: 401, data: { error: 'Sign in to continue.' } };
  const editsSetup = method !== 'GET' && (url.startsWith('/admin/candidates') || url.startsWith('/admin/positions') || url === '/admin/schedule' || url === '/admin/roster');
  if (editsSetup && electionClosed) return { ok: false, status: 409, data: { code: 'ELECTION_CLOSED', error: 'Voting is closed. Setup is locked; see Backup & reset to start another election (clears votes).' } };
  const result = await UI.request(url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  if (tok !== TOKEN || version !== authVersion) return { ok: false, data: { error: 'Session changed. Sign in again.' } };
  if (result.status === 401) {
    signOut();
    flash($('gatemsg'), 'err', 'Your session has expired or is invalid. Sign in again.');
  }
  if (result.status === 409 && (result.data.code === 'ELECTION_CLOSED' || result.data.error?.startsWith('Election is closed.'))) applyElectionStatus('closed');
  return result;
}

function loadConsole(stats, username) {
  sessionStorage.setItem('admintoken', TOKEN);
  $('password').value = '';
  $('gatemsg').className = 'msg';
  $('gate').style.display = 'none';
  $('console').style.display = 'block';
  $('whoami').textContent = username;
  render(stats);
  renderPositions().then(renderCandidates);
  prefillSettings();
  searchRoster(0);
  renderAdminUsers();
}

async function signIn() {
  if ($('signInBtn').disabled) return;
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) return flash($('gatemsg'), 'err', 'Enter your username and password.');
  $('signInBtn').disabled = true;
  try {
    const login = await UI.request('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!login.ok || !login.data.token) return flash($('gatemsg'), 'err', login.data.error || 'Could not sign in.');
    TOKEN = login.data.token;
    const version = ++authVersion;
    const r = await api('GET', '/admin/stats');
    if (version !== authVersion) return;
    if (!r.ok) { signOut(); return flash($('gatemsg'), 'err', r.data.error); }
    loadConsole(r.data, username);
  } finally { $('signInBtn').disabled = false; }
}

// Resume a stored session token without re-entering credentials.
async function resumeSession() {
  const version = ++authVersion;
  const me = await api('GET', '/admin/me');
  if (version !== authVersion) return;
  if (!me.ok) return signOut();
  const stats = await api('GET', '/admin/stats');
  if (!stats.ok) return signOut();
  loadConsole(stats.data, me.data.username);
}

function signOut() {
  authVersion++;
  clearInterval(timer); timer = null; TOKEN = ''; sessionStorage.removeItem('admintoken');
  if ($('auto')) $('auto').checked = false;
  if ($('password')) $('password').value = '';
  $('console').style.display = 'none'; $('gate').style.display = 'block';
  $('candidateEditor')?.close(); candidateList = []; positionList = []; electionId = null;
  $('rosterResults')?.replaceChildren(); $('rosterPreview')?.replaceChildren();
  if ($('roster')) $('roster').value = ''; reviewedCsv = ''; if ($('importBtn')) $('importBtn').disabled = true;
  $('username')?.focus();
}

async function prefillSettings() {
  const response = await UI.request('/info');
  if (!response.ok) return flash($('adminmsg'), 'err', response.data.error);
  const info = response.data;
  if (!TOKEN) return;
  applyElectionStatus(info.status);
  electionId = info.election_id;
  $('closeAt').value = '';
  $('title').value = info.title && info.title !== 'Student Council Election 2026' ? info.title : '';
  $('desc').value = info.description || '';
  if (info.close_at) {
    const local = new Date(info.close_at - new Date().getTimezoneOffset() * 60000);
    $('closeAt').value = local.toISOString().slice(0, 16);
  }
  if ($('consentPoints')) $('consentPoints').value = ((info.consent && info.consent.points) || []).join('\n');
}

function badge(status) {
  if (status === 'closed') return '<span class="badge warn"><svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="/icons.svg#clock"></use></svg> Closed</span>';
  if (status === 'held') return '<span class="badge warn">Voting on hold</span>';
  return '<span class="badge open pulse"><svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="/icons.svg#clock"></use></svg> Voting open</span>';
}

function applyElectionStatus(status) {
  electionClosed = status === 'closed';
  $('statusBadge').innerHTML = badge(status);
  $('adminState').textContent = electionClosed ? 'Closed - setup is locked' : status === 'held' ? 'Voting on hold' : 'Voting open';
  $('closedNotice').hidden = !electionClosed;
  for (const id of ['setupFields', 'positionFields', 'candidateFields', 'rosterFields', 'editFields', 'closeVotingBtn']) { const el = $(id); if (el) el.disabled = electionClosed; }
  $('holdVotingBtn').hidden = status !== 'open';
  $('resumeVotingBtn').hidden = status !== 'held';
  if (electionClosed && $('candidateEditor')?.open) flash($('editmsg'), 'err', 'Voting has closed. Candidate edits are now locked.');
}

// --- Analytics (per position) ---
function render(s) {
  applyElectionStatus(s.status);
  $('stats').innerHTML = [
    ['Eligible', s.eligible], ['Voted', s.voted],
    ['Ballots', s.ballots], ['Turnout', s.turnout_pct + '%'],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  if (window.countUp) $('stats').querySelectorAll('.n').forEach((el) => {
    const v = Number(el.textContent);
    if (Number.isInteger(v)) countUp(el, v, 700);
  });
  const positions = s.tally.positions || [];
  $('bars').innerHTML = positions.length ? positions.map((p) => positionBars(p, s.status)).join('') : '<div class="sub">No positions yet.</div>';
}

function outcomeLabel(p, status) {
  if (p.majority && p.majority.required) return `Majority: ${p.majority.pct}% of ${p.total} (needs &gt;50%) — <strong>${p.majority.passed ? 'PASS' : 'FAIL'}</strong>`;
  if (status !== 'closed') return `${p.total} vote(s)`;
  if (p.status === 'tie') return 'Tied — must be resolved';
  if (p.status === 'nota_plurality') return '“Not interested” leads — re-run needed';
  if (p.winner) return 'Winner: ' + escapeHtml(p.winner.name);
  if (p.status === 'no_votes') return 'No votes';
  return 'No winner';
}

function positionBars(p, status) {
  const rows = [...(p.results || []), { name: 'Not interested', votes: p.not_interested, nota: true }];
  const max = Math.max(1, ...rows.map((r) => r.votes));
  return `<div class="position-block" style="margin-bottom:1rem">
    <div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">${escapeHtml(p.title)}</h3><span class="sub">${outcomeLabel(p, status)}</span></div>
    ${rows.map((r) => {
      const win = status === 'closed' && p.winner && !r.nota && r.candidate_id === p.winner.candidate_id;
      return `<div class="bar-row ${win ? 'win' : ''}">
        <div class="name">${escapeHtml(r.name)}${r.nota ? '' : (r.active ? '' : ' (withdrawn)')}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(r.votes / max * 100).toFixed(1)}%"></div></div>
        <div class="v">${r.votes}</div></div>`;
    }).join('')}
  </div>`;
}

async function refresh() {
  const r = await api('GET', '/admin/stats');
  if (r.ok) { render(r.data); $('adminmsg').className = 'msg'; }
  else flash($('adminmsg'), 'err', r.data.error || 'Could not refresh.');
}
function toggleAuto() {
  clearInterval(timer);
  if ($('auto').checked) timer = setInterval(refresh, 5000);
}

// --- Positions ---
async function renderPositions() {
  const r = await api('GET', '/admin/positions');
  if (!r.ok) return flash($('posmsg'), 'err', r.data.error);
  positionList = r.data;
  const sel = $('candPosition');
  sel.innerHTML = positionList.length ? positionList.map((p) => `<option value="${p.position_id}">${escapeHtml(p.title)}</option>`).join('') : '<option value="">— add a position first —</option>';
  $('posList').innerHTML = positionList.length ? positionList.map((p) => `
    <div class="row" style="justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:.5rem 0">
      <div style="flex:1"><b>${escapeHtml(p.title)}</b> <span class="sub">${p.elig_levels ? 'Levels ' + escapeHtml(p.elig_levels) : 'All levels'}</span></div>
      <div class="row" style="gap:.4rem">
        <button class="ghost" style="padding:.35rem .7rem" onclick="editLevels(${p.position_id})">Levels</button>
        <button class="ghost" style="padding:.35rem .7rem" onclick="renamePosition(${p.position_id})">Rename</button>
        <button class="danger" style="padding:.35rem .7rem" onclick="delPosition(${p.position_id})">Delete</button>
      </div>
    </div>`).join('') : '<div class="sub">No positions yet. Add President, Secretary, etc.</div>';
}
async function addPosition() {
  const title = $('posTitle').value.trim();
  if (!title) return flash($('posmsg'), 'err', 'Enter a position title.');
  const r = await api('POST', '/admin/positions', { title, elig_levels: $('posLevels').value.trim() });
  if (!r.ok) return flash($('posmsg'), 'err', r.data.error || 'Failed.');
  $('posTitle').value = ''; $('posLevels').value = '';
  flash($('posmsg'), 'ok', 'Position added.');
  await renderPositions(); renderCandidates(); refresh();
}
async function editLevels(id) {
  const p = positionList.find((x) => x.position_id === id);
  if (!p) return;
  const val = prompt('Eligible levels (comma-separated, e.g. 6,7). Leave blank for all levels.', p.elig_levels || '');
  if (val === null) return;
  const r = await api('PATCH', '/admin/positions/' + id, { title: p.title, elig_levels: val.trim() });
  if (!r.ok) return flash($('posmsg'), 'err', r.data.error || 'Failed.');
  await renderPositions(); refresh();
  flash($('posmsg'), 'ok', 'Eligibility updated.');
}
// --- Internal tabs: Election tools / Dashboard / Ballots & voters ---
function setTab(name) {
  for (const [k, pid] of [['tools', 'toolsPanel'], ['dashboard', 'dashboardPanel'], ['ballots', 'ballotsPanel']]) { const el = $(pid); if (el) el.hidden = k !== name; }
  for (const [k, tid] of [['tools', 'tabTools'], ['dashboard', 'tabDashboard'], ['ballots', 'tabBallots']]) { const el = $(tid); if (el) el.classList.toggle('active', k === name); }
}
function showTools() { if (window.DASH && DASH.stop) DASH.stop(); setTab('tools'); }
function showDashboard() { setTab('dashboard'); if (window.DASH) DASH.refresh(); }
function showBallots() { if (window.DASH && DASH.stop) DASH.stop(); setTab('ballots'); renderBallots(); }

async function renderBallots() {
  const q = $('ballotSearch') ? $('ballotSearch').value.trim() : '';
  const r = await api('GET', '/admin/ballots' + (q ? '?q=' + encodeURIComponent(q) : ''));
  if (!r.ok) return flash($('ballotsMsg'), 'err', r.data.error || 'Could not load ballots.');
  const rows = r.data;
  const counted = rows.filter((b) => !b.voided).length;
  $('ballotsList').innerHTML = rows.length ? `
    <p class="sub">${rows.length} vote(s)${q ? ' matching "' + escapeHtml(q) + '"' : ''} — ${counted} counted, ${rows.length - counted} voided.</p>
    <table><thead><tr>
      <th title="When the vote was cast">Time</th>
      <th title="The student who cast this vote (from the roster)">Student ID</th>
      <th title="Student name from the roster">Name</th>
      <th title="The office being voted for">Position</th>
      <th title="Who the student voted for (or Not interested)">Choice</th>
      <th title="Counted = in the result. Voided = removed from the result but kept for audit.">Status</th>
      <th></th>
    </tr></thead><tbody>${rows.map((b) => `
      <tr${b.voided ? ' style="opacity:.55"' : ''}>
        <td>${new Date(Number(b.created_at)).toLocaleString()}</td>
        <td>${b.student_id ? escapeHtml(b.student_id) : '<span class="sub">—</span>'}</td>
        <td>${b.student_name ? escapeHtml(b.student_name) : '<span class="sub">—</span>'}</td>
        <td>${escapeHtml(b.position_title)}</td>
        <td>${b.candidate_name ? escapeHtml(b.candidate_name) : '<span class="sub">Not interested</span>'}</td>
        <td>${b.voided ? `<span class="badge warn" title="${escapeHtml(b.void_reason || '')}">Voided</span>` : '<span class="badge ok">Counted</span>'}</td>
        <td>${b.voided ? `<button class="ghost" style="padding:.3rem .6rem" onclick="restoreBallot('${b.ballot_id}')">Restore</button>` : `<button class="danger" style="padding:.3rem .6rem" onclick="voidBallot('${b.ballot_id}')">Void</button>`}</td>
      </tr>`).join('')}</tbody></table>` : `<div class="sub">${q ? 'No votes match that search.' : 'No votes cast yet.'}</div>`;
  $('ballotsMsg').className = 'msg';
}
async function voidBallot(id) {
  const reason = prompt('Reason for voiding this ballot (required):');
  if (reason === null) return;
  if (!reason.trim()) return flash($('ballotsMsg'), 'err', 'A reason is required.');
  const r = await api('POST', '/admin/ballots/' + encodeURIComponent(id) + '/void', { void: true, reason });
  if (!r.ok) return flash($('ballotsMsg'), 'err', r.data.error || 'Failed.');
  flash($('ballotsMsg'), 'ok', 'Ballot voided and removed from the tally.'); renderBallots(); refresh();
}
async function restoreBallot(id) {
  if (!confirm('Restore this ballot to the tally?')) return;
  const r = await api('POST', '/admin/ballots/' + encodeURIComponent(id) + '/void', { void: false });
  if (!r.ok) return flash($('ballotsMsg'), 'err', r.data.error || 'Failed.');
  flash($('ballotsMsg'), 'ok', 'Ballot restored.'); renderBallots(); refresh();
}
async function renamePosition(id) {
  const p = positionList.find((x) => x.position_id === id);
  const title = prompt('Rename position', p ? p.title : '');
  if (title == null || !title.trim()) return;
  const r = await api('PATCH', '/admin/positions/' + id, { title: title.trim() });
  if (!r.ok) return flash($('posmsg'), 'err', r.data.error || 'Failed.');
  await renderPositions(); renderCandidates(); refresh();
}
async function delPosition(id) {
  if (!confirm('Delete this position and its candidates? Blocked if it already has votes.')) return;
  const r = await api('DELETE', '/admin/positions/' + id);
  if (!r.ok) return flash($('posmsg'), 'err', r.data.error || 'Could not delete.');
  flash($('posmsg'), 'ok', 'Position deleted.');
  await renderPositions(); renderCandidates(); refresh();
}

// --- Candidates ---
function selectedPosition() { return Number($('candPosition').value) || null; }

async function addCandidates() {
  const position_id = selectedPosition();
  if (!position_id) return flash($('candmsg'), 'err', 'Choose a position first.');
  const csv = $('cands').value.trim();
  if (!csv) return flash($('candmsg'), 'err', 'Paste at least one line.');
  const r = await api('POST', '/admin/candidates', { position_id, csv });
  if (!r.ok) return flash($('candmsg'), 'err', r.data.error || 'Failed.');
  flash($('candmsg'), 'ok', `Added ${r.data.added} candidate(s).${r.data.grouped ? ' Ballot positions were arranged.' : ''}`);
  $('cands').value = '';
  await renderPositions(); renderCandidates(); refresh();
}

async function importLevelFile() {
  const title = $('levelTitle').value.trim();
  const file = $('levelFile').files[0];
  if (!title || !file) return flash($('levelmsg'), 'err', 'Enter the position name and choose its CSV file.');
  if (file.size > 2 * 1024 * 1024) return flash($('levelmsg'), 'err', 'CSV file must be under 2 MB.');
  $('levelImportBtn').disabled = true;
  try {
    const csv = await file.text();
    const r = await api('POST', '/admin/positions/import-levels', { title, csv });
    if (!r.ok) return flash($('levelmsg'), 'err', r.uncertain ? 'Import status is unknown. Refresh positions before trying again.' : r.data.error || 'Import failed.');
    flash($('levelmsg'), 'ok', 'Created ' + r.data.created.map(p => `${p.title} (${p.candidates})`).join(', ') + '.');
    $('levelTitle').value = ''; $('levelFile').value = '';
    await renderPositions(); await renderCandidates(); refresh();
  } catch { flash($('levelmsg'), 'err', 'Could not read this CSV file.'); }
  finally { $('levelImportBtn').disabled = false; }
}

async function addOne() {
  if ($('addBtn').disabled) return;
  const position_id = selectedPosition();
  if (!position_id) return flash($('candmsg'), 'err', 'Choose a position first.');
  const name = $('cName').value.trim();
  if (!name) return flash($('candmsg'), 'err', 'Enter a candidate name.');
  $('addBtn').disabled = true;
  try {
    const data = await UI.photoData($('newPhoto').files[0]);
    const r = await api('POST', '/admin/candidates', { position_id, candidates: [{ name, description: $('cDesc').value.trim() }] });
    if (!r.ok) return flash($('candmsg'), 'err', r.uncertain ? 'Could not confirm creation. Refresh the candidate list before adding again.' : r.data.error);
    let photoResult = { ok: true };
    if (data) photoResult = await api('PUT', '/admin/candidates/' + r.data.ids[0] + '/photo', { data });
    flash($('candmsg'), photoResult.ok ? 'ok' : 'err', photoResult.ok ? 'Candidate added.' : 'Candidate added, but photo failed: ' + photoResult.data.error + ' Use Edit to retry.');
    $('cName').value = ''; $('cDesc').value = ''; $('newPhoto').value = ''; $('newPhotoPreview').replaceChildren();
    await renderCandidates(); refresh();
  } catch (error) { flash($('candmsg'), 'err', error.message); }
  finally { $('addBtn').disabled = false; }
}

async function renderCandidates() {
  const r = await api('GET', '/admin/candidates');
  if (!r.ok) return flash($('candmsg'), 'err', r.data.error);
  candidateList = r.data;
  const el = $('candList');
  if (!positionList.length) { el.innerHTML = '<div class="sub">Add a position first, then add its candidates.</div>'; return; }
  el.innerHTML = positionList.map((p) => {
    const cands = candidateList.filter((c) => c.position_id === p.position_id);
    const body = cands.length ? cands.map((c) => `
      <div class="row" style="justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:.6rem 0;${c.active ? '' : 'opacity:.55'}">
        ${UI.portrait(c)}<div style="flex:1">
          <b>${escapeHtml(c.name)}</b> ${c.active ? '' : '<span class="badge warn">Withdrawn</span>'}
          ${c.description ? `<div class="sub">${escapeHtml(c.description)}</div>` : ''}
        </div>
        <div class="row" style="gap:.4rem"><button class="ghost" onclick="editCandidate(${c.candidate_id})">Edit</button>
          <button class="ghost" style="padding:.35rem .7rem" onclick="toggleActive(${c.candidate_id}, ${c.active ? 0 : 1})">${c.active ? 'Withdraw' : 'Reactivate'}</button>
          <button class="danger" style="padding:.35rem .7rem" onclick="delCandidate(${c.candidate_id})">Delete</button>
        </div>
      </div>`).join('') : '<div class="sub">No candidates yet.</div>';
    return `<div class="position-block" style="margin-bottom:1rem"><h3 style="margin:.4rem 0">${escapeHtml(p.title)}</h3>${body}</div>`;
  }).join('');
}

async function toggleActive(id, to) {
  const r = await api('POST', '/admin/candidates/' + id + '/active', { active: !!to });
  if (!r.ok) return flash($('candmsg'), 'err', r.data.error || 'Failed.');
  flash($('candmsg'), 'ok', to ? 'Candidate reactivated.' : 'Candidate withdrawn — hidden from the ballot, votes kept.');
  renderCandidates(); refresh();
}

async function delCandidate(id) {
  if (!confirm('Delete this candidate?')) return;
  const r = await api('DELETE', '/admin/candidates/' + id);
  if (!r.ok) return flash($('candmsg'), 'err', r.data.error || 'Could not delete (it may already have votes).');
  flash($('candmsg'), 'ok', 'Deleted.');
  renderCandidates(); refresh();
}

function editCandidate(id) {
  if (electionClosed) return flash($('candmsg'), 'err', 'Candidate details are locked after closing.');
  const candidate = candidateList.find(c => c.candidate_id === id);
  if (!candidate) return;
  editingId = id; $('editName').value = candidate.name; $('editDesc').value = candidate.description || '';
  $('editPhoto').value = ''; $('removePhoto').checked = false;
  $('editPhotoPreview').innerHTML = UI.portrait(candidate); $('editmsg').className = 'msg';
  $('candidateEditor').showModal(); $('editName').focus();
}
async function saveCandidate() {
  if ($('saveCandidateBtn').disabled) return;
  $('saveCandidateBtn').disabled = true;
  try {
    const data = await UI.photoData($('editPhoto').files[0]);
    if (data && $('removePhoto').checked) return flash($('editmsg'), 'err', 'Choose either a replacement photo or removal.');
    const r = await api('PATCH', '/admin/candidates/' + editingId, { name: $('editName').value, description: $('editDesc').value });
    if (!r.ok) return flash($('editmsg'), 'err', r.data.error);
    let photo = { ok: true };
    if (data) photo = await api('PUT', '/admin/candidates/' + editingId + '/photo', { data });
    else if ($('removePhoto').checked) photo = await api('DELETE', '/admin/candidates/' + editingId + '/photo');
    await renderCandidates(); refresh();
    if (!photo.ok) return flash($('editmsg'), 'err', 'Details saved. Photo update failed: ' + photo.data.error);
    $('candidateEditor').close(); flash($('candmsg'), 'ok', 'Candidate updated.');
  } catch (error) { flash($('editmsg'), 'err', error.message); }
  finally { $('saveCandidateBtn').disabled = false; }
}

// --- Roster ---
async function uploadRoster() {
  if (!reviewedCsv || reviewedCsv !== $('roster').value || $('importBtn').disabled) return flash($('rostermsg'), 'err', 'Preview the current CSV first.');
  $('importBtn').disabled = true;
  const r = await api('POST', '/admin/roster', { csv: reviewedCsv });
  if (!r.ok) return flash($('rostermsg'), 'err', r.data.error + ' Preview again to retry.');
  flash($('rostermsg'), 'ok', 'Added ' + r.data.added + ' new eligible voter(s).');
  reviewedCsv = ''; $('rosterPreview').replaceChildren();
  searchRoster(0); refresh();
}
async function previewRoster() {
  const csv = $('roster').value;
  reviewedCsv = ''; $('importBtn').disabled = true;
  if (!csv.trim()) return flash($('rostermsg'), 'err', 'Choose a CSV file or paste roster rows first.');
  const r = await api('POST', '/admin/roster/preview', { csv });
  if (!r.ok) return flash($('rostermsg'), 'err', r.data.error);
  if ($('roster').value !== csv) return;
  const p = r.data;
  $('rosterPreview').innerHTML = `<p>${p.added} new, ${p.skipped} existing/duplicate, ${p.errors.length} invalid. Showing the first 100 rows.</p><table><thead><tr><th>Line</th><th>Student ID</th><th>Name</th><th>Action</th></tr></thead><tbody>${p.rows.slice(0,100).map(r => `<tr><td>${r.line}</td><td>${UI.escape(r.student_id)}</td><td>${UI.escape(r.name)}</td><td>${r.status === 'new' ? 'Add' : 'Skip (' + r.status + ')'}</td></tr>`).join('')}</tbody></table>${p.errors.slice(0,100).map(e => `<p class="error-text">Line ${e.line}: ${UI.escape(e.error)}</p>`).join('')}`;
  if (p.errors.length) return flash($('rostermsg'), 'err', 'Fix the invalid rows, then preview again. No data has been imported.');
  reviewedCsv = csv; $('importBtn').disabled = p.added === 0;
  flash($('rostermsg'), 'ok', p.added ? 'Review the rows, then choose Import reviewed rows.' : 'No new voters to import.');
}
async function searchRoster(offset = 0) {
  const serial = ++rosterRequest;
  const params = new URLSearchParams({ q: $('rosterQuery').value, status: $('rosterStatus').value, offset: String(Math.max(0, offset)) });
  const r = await api('GET', '/admin/roster?' + params);
  if (serial !== rosterRequest) return;
  if (!r.ok) { $('rosterResults').textContent = r.data.error; return; }
  rosterOffset = r.data.offset;
  $('rosterResults').innerHTML = `<p>${r.data.total} matching voters${r.data.total ? ' - showing ' + (rosterOffset + 1) + ' to ' + (rosterOffset + r.data.rows.length) : ''}</p><table><thead><tr><th>Student ID</th><th>Name</th><th>Status</th></tr></thead><tbody>${r.data.rows.map(row => `<tr><td>${UI.escape(row.student_id)}</td><td>${UI.escape(row.name || '-')}</td><td><span class="badge ${row.token_used ? 'ok' : 'open'}">${row.token_used ? 'Voted' : row.checked_in ? 'Code sent, not voted' : 'Not voted'}</span></td></tr>`).join('')}</tbody></table>`;
  $('rosterPrev').disabled = rosterOffset === 0; $('rosterNext').disabled = rosterOffset + 50 >= r.data.total;
}

// --- Close / approve / schedule ---
async function holdVoting() {
  const r = await api('POST', '/admin/hold', {});
  if (!r.ok) return flash($('controlmsg'), 'err', r.data.error || 'Could not hold voting.');
  applyElectionStatus('held');
  flash($('controlmsg'), 'ok', 'Voting is on hold. Existing votes are safe; no new votes can be cast.');
  refresh();
}
async function resumeVoting() {
  const r = await api('POST', '/admin/resume', {});
  if (!r.ok) return flash($('controlmsg'), 'err', r.data.error || 'Could not resume voting.');
  applyElectionStatus('open');
  flash($('controlmsg'), 'ok', 'Voting resumed. Eligible voters can continue.');
  refresh();
}
async function closeVoting() {
  if (electionClosed) return;
  if (!confirm('Close voting? No further ballots can be cast. This cannot be undone.')) return;
  const r = await api('POST', '/admin/close', {});
  if (!r.ok) return flash($('controlmsg'), 'err', r.data.error || 'Failed.');
  flash($('controlmsg'), r.data.verify.ok ? 'ok' : 'err', `Voting closed. Verification: ${r.data.verify.ok ? 'PASSED' : 'FAILED'}.`);
  refresh();
}
async function approve() {
  const approver = $('approver').value.trim();
  if (!approver) return flash($('controlmsg'), 'err', 'Enter the approver name.');
  const r = await api('POST', '/admin/approve', { approver });
  if (!r.ok) return flash($('controlmsg'), 'err', r.data.error || 'Approval blocked.');
  flash($('controlmsg'), 'ok', `Result approved by ${r.data.by}. Published to the results page.`);
  if (window.confetti) confetti();
  refresh();
}
async function saveSchedule() {
  const title = $('title').value.trim();
  const v = $('closeAt').value;
  const close_at = v ? new Date(v).getTime() : null;
  if (v && !Number.isFinite(close_at)) return flash($('schedmsg'), 'err', 'Enter a valid close time.');
  const r = await api('POST', '/admin/schedule', { title, description: $('desc').value.trim(), close_at });
  if (!r.ok) return flash($('schedmsg'), 'err', r.data.error || 'Failed.');
  flash($('schedmsg'), 'ok', 'Settings saved.');
  refresh();
}
async function saveConsent() {
  const r = await api('POST', '/admin/schedule', { consent_points: $('consentPoints').value });
  if (!r.ok) return flash($('consentmsg'), 'err', r.data.error || 'Failed.');
  flash($('consentmsg'), 'ok', 'Consent declaration saved.');
}
async function clearSchedule() {
  const r = await api('POST', '/admin/schedule', { close_at: null });
  if (!r.ok) return flash($('schedmsg'), 'err', r.data.error || 'Failed.');
  $('closeAt').value = '';
  flash($('schedmsg'), 'ok', 'Deadline cleared.');
}

// --- Admin accounts ---
async function renderAdminUsers() {
  const r = await api('GET', '/admin/users');
  if (!r.ok) return;
  $('adminUsers').innerHTML = r.data.map((u) => `
    <div class="row" style="justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:.5rem 0">
      <b>${escapeHtml(u.username)}</b>
      <button class="danger" style="padding:.35rem .7rem" onclick="delAdmin('${escapeHtml(u.username)}')">Remove</button>
    </div>`).join('');
}
async function addAdmin() {
  const username = $('newAdminUser').value.trim();
  const password = $('newAdminPass').value;
  if (!username || !password) return flash($('usersmsg'), 'err', 'Enter a username and password (min 8 chars).');
  const r = await api('POST', '/admin/users', { username, password });
  if (!r.ok) return flash($('usersmsg'), 'err', r.data.error || 'Failed.');
  $('newAdminUser').value = ''; $('newAdminPass').value = '';
  flash($('usersmsg'), 'ok', 'Admin added.');
  renderAdminUsers();
}
async function delAdmin(username) {
  if (!confirm('Remove admin "' + username + '"?')) return;
  const r = await api('DELETE', '/admin/users/' + encodeURIComponent(username));
  if (!r.ok) return flash($('usersmsg'), 'err', r.data.error || 'Failed.');
  flash($('usersmsg'), 'ok', 'Admin removed.');
  renderAdminUsers();
}

// --- Backup / reset ---
async function downloadBackup() {
  $('backupBtn').disabled = true;
  try {
    const r = await api('GET', '/admin/backup');
    if (!r.ok) return flash($('resetmsg'), 'err', r.data.error);
    UI.download(new Blob([JSON.stringify(r.data)], { type: 'application/json' }), 'election-backup-' + new Date().toISOString().slice(0,10) + '.json');
    flash($('resetmsg'), 'ok', 'Backup download started. Confirm the file is saved before resetting.');
  } finally { $('backupBtn').disabled = false; }
}
// Jump to the Backup & reset card armed for a fresh election. Keeps the typed
// confirmation phrase + backup acknowledgement — no one-click data wipe.
function startNewElection() {
  $('resetMode').value = 'new';
  resetPrompt();
  $('resetSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  flash($('resetmsg'), 'ok', 'Download a backup if needed, tick the box, type START NEW ELECTION, then confirm.');
  $('resetPhrase').focus();
}

function resetPrompt() {
  const practice = $('resetMode').value === 'practice';
  $('resetExpected').textContent = practice ? 'RESET PRACTICE VOTES' : 'START NEW ELECTION';
  $('resetHelp').textContent = practice ? 'Deletes all ballots and clears voting status, deadline, and approval. Keeps positions, candidates, photos, roster, title, and description. Voting reopens.' : 'Deletes all election data and candidate photos, including positions. Signing keys and admin accounts are preserved. A blank election opens.';
  $('resetPhrase').value = ''; $('backupAcknowledged').checked = false;
}
async function performReset() {
  if ($('resetBtn').disabled) return;
  if (!$('backupAcknowledged').checked || $('resetPhrase').value !== $('resetExpected').textContent) return flash($('resetmsg'), 'err', 'Confirm the backup choice and type the exact phrase.');
  $('resetBtn').disabled = true;
  clearInterval(timer); $('auto').checked = false;
  const r = await api('POST', '/admin/reset', { mode: $('resetMode').value, confirmation: $('resetPhrase').value, election_id: electionId });
  if (r.ok) {
    electionId = r.data.election_id;
    $('approver').value = ''; $('controlmsg').className = 'msg'; $('rosterPreview').replaceChildren(); reviewedCsv = ''; $('importBtn').disabled = true;
    await Promise.all([prefillSettings(), renderPositions(), refresh(), searchRoster(0)]);
    await renderCandidates();
    resetPrompt(); flash($('resetmsg'), 'ok', 'Election reset. Old voting sessions are no longer valid.');
  } else flash($('resetmsg'), 'err', r.uncertain ? 'Reset status is unknown. Refresh the page and inspect the election before trying again.' : r.data.error);
  $('resetBtn').disabled = false;
}

async function loadRosterFile(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { input.value = ''; return flash($('rostermsg'), 'err', 'CSV file must be under 2 MB.'); }
  try {
    $('roster').value = await file.text();
    reviewedCsv = ''; $('importBtn').disabled = true;
    await previewRoster();
  } catch { flash($('rostermsg'), 'err', 'Could not read this file.'); }
}

$('roster').addEventListener('input', () => { reviewedCsv = ''; $('importBtn').disabled = true; $('rosterPreview').replaceChildren(); });
$('rosterQuery').addEventListener('keydown', event => { if (event.key === 'Enter') searchRoster(0); });
$('ballotSearch')?.addEventListener('keydown', event => { if (event.key === 'Enter') renderBallots(); });
$('password').addEventListener('keydown', event => { if (event.key === 'Enter') signIn(); });
$('username').addEventListener('keydown', event => { if (event.key === 'Enter') $('password').focus(); });
resetPrompt();
if (TOKEN) resumeSession();

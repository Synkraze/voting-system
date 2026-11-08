// Home page reads the same public election data as the voting page.
const $ = (id) => document.getElementById(id);
let electionInfo = null;

async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

function renderSchedule() {
  if (!electionInfo) return;
  const status = electionInfo.status || 'open';
  const pill = $('election-status');
  pill.className = 'status-pill ' + (['open', 'closed', 'held'].includes(status) ? status : '');
  if (status === 'closed') pill.textContent = 'Voting closed';
  else if (status === 'held') pill.textContent = 'Voting on hold';
  else pill.textContent = 'Voting open';

  const closeAt = electionInfo.close_at;
  $('election-close').textContent = closeAt
    ? 'Closes ' + new Date(closeAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Closing time to be announced';
  $('results-note').textContent = status === 'closed'
    ? 'Voting has closed. See the final tally and its approval status.'
    : 'The results will be published once the voting process has officially closed.';
}

function renderInfo(info) {
  electionInfo = info;
  $('election-name').textContent = info.title || 'Student Council Election 2026';
  $('election-description').textContent = info.description || 'Explore the positions and candidates, then cast your ballot.';
  renderSchedule();
}

function addPosition(parent, position) {
  const row = document.createElement('div');
  row.className = 'position-item';
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = position.title;
  const count = document.createElement('small');
  const total = position.candidates.length;
  count.textContent = total + ' candidate' + (total === 1 ? '' : 's');
  copy.append(title, count);
  const arrow = document.createElement('span');
  arrow.className = 'position-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '↗';
  row.append(copy, arrow);
  parent.append(row);
}

function addCandidate(parent, candidate, positionTitle) {
  const card = document.createElement('div');
  card.className = 'candidate-card';
  const portrait = document.createElement('div');
  portrait.className = 'candidate-photo';
  portrait.setAttribute('aria-hidden', 'true');
  portrait.textContent = candidate.name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0] || '').join('').toUpperCase();
  if (/^\/uploads\/[a-f0-9-]+\.webp$/.test(candidate.photo || '')) {
    const image = document.createElement('img');
    image.src = candidate.photo;
    image.alt = '';
    image.loading = 'lazy';
    image.onerror = () => image.remove();
    portrait.append(image);
  }
  const copy = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = candidate.name;
  const role = document.createElement('small');
  role.textContent = positionTitle;
  copy.append(name, role);
  card.append(portrait, copy);
  parent.append(card);
}

function renderPositions(positions) {
  const positionList = $('position-list');
  const candidateList = $('candidate-list');
  positionList.replaceChildren();
  candidateList.replaceChildren();
  if (!positions.length) {
    positionList.innerHTML = '<div class="empty-state">Positions will appear once the election is set up.</div>';
    candidateList.innerHTML = '<div class="empty-state">Candidates will appear once they are added.</div>';
    return;
  }
  positions.forEach((position) => addPosition(positionList, position));
  const candidates = positions.flatMap((position) => position.candidates.map((candidate) => ({ candidate, positionTitle: position.title })));
  if (!candidates.length) {
    candidateList.innerHTML = '<div class="empty-state">Candidates will appear once they are added.</div>';
    return;
  }
  candidates.slice(0, 6).forEach(({ candidate, positionTitle }) => addCandidate(candidateList, candidate, positionTitle));
}

async function load() {
  const [info, positions] = await Promise.allSettled([getJson('/info'), getJson('/positions')]);
  if (info.status === 'fulfilled') renderInfo(info.value);
  else {
    $('election-name').textContent = 'Election information unavailable';
    $('election-description').textContent = 'Refresh this page when the election service is available.';
    $('election-status').textContent = 'Unable to check status';
    $('election-close').textContent = '';
  }
  if (positions.status === 'fulfilled') renderPositions(positions.value);
  else {
    $('position-list').innerHTML = '<div class="empty-state">Could not load positions. Please refresh this page.</div>';
    $('candidate-list').innerHTML = '<div class="empty-state">Could not load candidates. Please refresh this page.</div>';
  }
}

document.querySelector('.identity img').addEventListener('error', (event) => {
  event.currentTarget.style.display = 'none';
  document.querySelector('.identity-fallback').style.display = 'block';
});
load();
setInterval(() => { if (!document.hidden) load(); }, 20000);

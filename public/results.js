const $ = id => document.getElementById(id);
let loading = false, lastResult = '', celebrated = '';
function badge(ok, text) { return `<span class="badge ${ok ? 'ok' : 'warn'}">${UI.escape(text)}</span>`; }

function positionOutcome(p) {
  if (p.majority && p.majority.required) {
    const c = p.results[0];
    return {
      headline: c ? c.name : 'Single candidate',
      detail: `${p.majority.pct}% of ${p.total} vote(s) — ${p.majority.passed ? 'elected (cleared the >50% majority)' : 'NOT elected (did not reach >50%)'}.`,
      winner: p.majority.passed ? c : null,
    };
  }
  if (p.status === 'tie') return { headline: 'Tied', detail: (p.tied || []).map(c => c.name).join(' & ') + ' tied at ' + (p.tied?.[0]?.votes ?? 0) + ' votes. Pending resolution.', winner: null };
  if (p.status === 'nota_plurality') return { headline: '“Not interested” leads', detail: 'More voters chose "Not interested" than any candidate. A re-run may be needed.', winner: null };
  if (p.winner) return { headline: p.winner.name, detail: 'Elected with ' + p.winner.votes + ' of ' + p.total + ' votes.', winner: p.winner };
  return { headline: 'No winner', detail: 'No votes were cast for this position.', winner: null };
}

function positionCard(p) {
  const o = positionOutcome(p);
  const rows = [...p.results, { name: 'Not interested', description: '', votes: p.not_interested, nota: true, active: true }];
  const body = rows.map(c => `<tr><td><div class="candidate-cell">${c.nota ? '' : UI.portrait(c)}<div><strong>${UI.escape(c.name)}</strong><div class="sub">${UI.escape(c.description || '')}</div></div></div></td><td>${c.nota ? '—' : (c.active ? 'Active' : 'Withdrawn')}</td><td>${c.votes}</td><td>${p.total ? (100 * c.votes / p.total).toFixed(1) : '0'}%</td></tr>`).join('');
  return `<div class="card"><div class="row" style="justify-content:space-between;align-items:baseline"><h2>${UI.escape(p.title)}</h2>${o.winner ? badge(true, 'Winner: ' + o.winner.name) : badge(false, o.headline)}</div>
    <p class="sub">${UI.escape(o.detail)}</p>
    <div class="table-scroll"><table class="results-table"><thead><tr><th>Candidate</th><th>Status</th><th>Votes</th><th>Share</th></tr></thead><tbody>${body}</tbody><tfoot><tr><th colspan="2">Total votes</th><td>${p.total}</td><td></td></tr></tfoot></table></div></div>`;
}

async function load() {
  if (loading || document.hidden) return;
  loading = true;
  try {
    const response = await UI.request('/result');
    if (!response.ok) { $('resultmsg').className = 'msg show err'; $('resultmsg').textContent = 'Could not refresh results. Any results below may be out of date. Retrying automatically.'; return; }
    $('resultmsg').className = 'msg';
    const r = response.data, key = JSON.stringify(r);
    if (key === lastResult) return;
    lastResult = key;
    if (r.status !== 'closed') {
      $('content').innerHTML = '<div class="card center"><div class="ic"><svg class="icon" aria-hidden="true"><use href="/icons.svg#clock"></use></svg></div><h2>Voting is in progress</h2><p class="sub">Results appear automatically when polls close. Live counts are hidden to keep the vote fair.</p></div>';
      return;
    }
    const t = r.tally, positions = t.positions || [];
    const header = `<div class="result-toolbar"><span>${UI.escape(r.title)}</span><div class="row"><a class="primary-link" href="/results.csv">Download CSV</a><button class="ghost" onclick="window.print()">Print result sheet</button></div></div>
      <div class="card"><div class="row">${badge(!!r.approved_by, r.approved_by ? 'Approved by ' + r.approved_by : 'Awaiting official approval')}<span class="badge ${r.verify.ok ? 'ok' : 'bad'}">${r.verify.ok ? 'Verification passed' : 'Verification FAILED'}</span></div>${r.approved_at ? '<p class="sub">Approved: ' + UI.escape(new Date(r.approved_at).toLocaleString()) + '</p>' : ''}<p class="sub">${t.total} ballot(s) across ${positions.length} position(s).</p></div>`;
    const cards = positions.length ? positions.map(positionCard).join('') : '<div class="card center"><h2>No positions</h2></div>';
    const verifyCard = `<div class="card"><h2>Verification record</h2><p class="sub">${r.verify.count} ballots checked. ${r.verify.ok ? 'Ballot signatures and the saved chain root match.' : 'The record could not be verified. Contact the election official before relying on this result.'}</p><p class="mono">${UI.escape(r.root || 'No root')}</p><a href="/verify">View independent verification</a></div>`;
    $('content').innerHTML = header + cards + verifyCard;
    const anyWinner = positions.some(p => positionOutcome(p).winner);
    if (anyWinner && r.verify.ok && celebrated !== r.election_id) { celebrated = r.election_id; if (window.confetti) confetti({ count: 90 }); }
  } finally { loading = false; }
}
load();
setInterval(load, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

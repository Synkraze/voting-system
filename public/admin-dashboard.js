// Admin dashboard: Chart.js visuals driven by /admin/stats and
// /admin/stats/timeline. Reuses $, api(), UI and TOKEN from admin.js (same
// global scope, loaded first) and the Chart global from the vendored
// chart.umd.min.js. Charts render only while the Dashboard tab is visible.
(function () {
  const PALETTE = ['#1e40af', '#3b82f6', '#0f9d6e', '#7c3aed', '#db2777', '#0891b2', '#b45309', '#65a30d', '#be123c', '#0d9488'];
  const NOTA = '#94a3b8';
  const charts = {};
  let autoTimer = null;

  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.color = '#5d6b86';
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.animation.duration = 650;
  Chart.defaults.animation.easing = 'easeOutQuart';

  // Create or update a chart. Chart.js can't change type on update, so recreate
  // when the type differs (e.g. the vote-share toggle: bar <-> doughnut).
  function upsert(id, config) {
    const existing = charts[id];
    if (existing && existing.config.type === config.type) {
      existing.data = config.data;
      existing.options = config.options;
      existing.update();
      return existing;
    }
    if (existing) { existing.destroy(); delete charts[id]; }
    const el = document.getElementById(id);
    if (!el) return null;
    charts[id] = new Chart(el.getContext('2d'), config);
    return charts[id];
  }

  function renderCards(s) {
    const positions = s.tally.positions || [];
    const decided = positions.filter((p) => p.status === 'winner' || p.status === 'majority_pass').length;
    const pending = positions.length - decided;
    const items = [
      ['Eligible', s.eligible, 'Students on the roster who are allowed to vote.'],
      ['Voted', s.voted, 'Students who have cast their ballot.'],
      ['Turnout', s.turnout_pct + '%', 'Voted divided by eligible.'],
      ['Ballots', s.ballots, 'Total position-votes recorded (each voter casts one per position).'],
      ['Decided', decided, 'Positions with a clear winner or a passed majority.'],
      ['Pending / tie', pending, 'Positions not yet decided, tied, or with no votes.'],
    ];
    $('dashCards').innerHTML = items.map(([l, n, t]) => `<div class="stat" title="${t}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
    if (window.countUp) $('dashCards').querySelectorAll('.n').forEach((el) => {
      const v = Number(el.textContent);
      if (Number.isInteger(v)) countUp(el, v, 700);
    });
    const v = s.verify || {};
    $('dashIntegrity').innerHTML = v.ok
      ? `<span class="badge ok">Chain verified · ${v.count} ballot(s)</span>`
      : `<span class="badge warn">Verify: ${UI.escape(v.reason || 'pending')}</span>`;
    $('dashLive').textContent = s.status === 'closed' ? 'Final results.'
      : s.status === 'held' ? 'Voting on hold — live overview, officials only.'
      : 'Live overview — officials only while polls are open.';
  }

  function renderTurnout(s) {
    const voted = s.voted, rest = Math.max(0, s.eligible - voted);
    upsert('chartTurnout', {
      type: 'doughnut',
      data: { labels: ['Voted', 'Not yet'], datasets: [{ data: [voted, rest], backgroundColor: ['#0f9d6e', '#e3e9f2'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { position: 'bottom' } } },
    });
    $('chartTurnoutData').textContent = `Voted ${voted} of ${s.eligible} eligible (${s.turnout_pct}%).`;
  }

  function renderFunnel(s) {
    // checked_in persists after voting, so it already includes everyone who voted.
    upsert('chartFunnel', {
      type: 'bar',
      data: { labels: ['Eligible', 'Code sent', 'Voted'], datasets: [{ data: [s.eligible, s.checked_in, s.voted], backgroundColor: ['#3b82f6', '#6366f1', '#0f9d6e'], borderRadius: 6 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
    $('chartFunnelData').textContent = `Eligible ${s.eligible}, code sent ${s.checked_in}, voted ${s.voted}.`;
  }

  async function renderTimeline() {
    const r = await api('GET', '/admin/stats/timeline');
    if (!r.ok) return;
    const pts = r.data.points || [];
    upsert('chartTimeline', {
      type: 'line',
      data: {
        labels: pts.map((p) => new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        datasets: [{ label: 'Cumulative voters', data: pts.map((p) => p.cumulative), fill: true, borderColor: '#1e40af', backgroundColor: 'rgba(30,64,175,.12)', tension: 0.3, pointRadius: 2 }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
    $('chartTimelineData').textContent = pts.length ? `Cumulative voters reached ${pts[pts.length - 1].cumulative}.` : 'No ballots yet.';
  }

  function renderPositions(s) {
    const share = $('dashShare').checked;
    const list = s.tally.positions || [];
    const host = $('dashPositions');
    // Rebuild the canvases only when the set of positions changes.
    const sig = list.map((p) => p.position_id).join(',');
    if (host.dataset.sig !== sig) {
      Object.keys(charts).filter((k) => k.startsWith('pos-')).forEach((k) => { charts[k].destroy(); delete charts[k]; });
      host.innerHTML = list.length
        ? list.map((p) => `<div class="card"><h4 style="margin:.2rem 0">${UI.escape(p.title)}</h4><div class="chart-box"><canvas id="pos-${p.position_id}" role="img" aria-label="${UI.escape(p.title)} results"></canvas></div><div class="sub" id="posd-${p.position_id}"></div></div>`).join('')
        : '<div class="sub">No positions yet.</div>';
      host.dataset.sig = sig;
    }
    for (const p of list) {
      const rows = [...p.results, { name: 'Not interested', votes: p.not_interested, nota: true }];
      const colors = rows.map((row, i) => (row.nota ? NOTA : PALETTE[i % PALETTE.length]));
      upsert('pos-' + p.position_id, {
        type: share ? 'doughnut' : 'bar',
        data: { labels: rows.map((row) => row.name), datasets: [{ data: rows.map((row) => row.votes), backgroundColor: colors, borderRadius: share ? 0 : 6, borderWidth: 0 }] },
        options: share
          ? { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
          : { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
      });
      const outcome = p.winner ? 'Winner: ' + p.winner.name
        : p.status === 'tie' ? 'Tied — must be resolved'
        : p.status === 'nota_plurality' ? '“Not interested” leads'
        : p.status === 'majority_fail' ? 'Majority not reached'
        : p.status === 'no_votes' ? 'No votes'
        : (s.status === 'closed' ? 'No winner' : 'In progress');
      $('posd-' + p.position_id).textContent = outcome + (p.majority && p.majority.required ? ` · ${p.majority.pct}% (needs >50%)` : '');
    }
  }

  async function refresh() {
    if (!TOKEN) { stopAuto(); return; } // signed out — stop polling
    const r = await api('GET', '/admin/stats');
    if (!r.ok) return flash($('dashMsg'), 'err', r.data.error || 'Could not load dashboard.');
    $('dashMsg').className = 'msg';
    const s = r.data;
    renderCards(s); renderTurnout(s); renderFunnel(s); renderPositions(s);
    await renderTimeline();
  }

  function stopAuto() { clearInterval(autoTimer); autoTimer = null; }
  function toggleAuto() { stopAuto(); if ($('dashAuto').checked) autoTimer = setInterval(refresh, 5000); }

  function open() {
    $('toolsPanel').hidden = true;
    $('dashboardPanel').hidden = false;
    $('tabDashboard').classList.add('active');
    $('tabTools').classList.remove('active');
    refresh();
  }
  function close() {
    stopAuto();
    if ($('dashAuto')) $('dashAuto').checked = false;
    $('dashboardPanel').hidden = true;
    $('toolsPanel').hidden = false;
    $('tabTools').classList.add('active');
    $('tabDashboard').classList.remove('active');
  }

  window.DASH = { open, close, refresh, toggleAuto, stop: stopAuto };

  // DOM is already parsed when this deferred script runs.
  $('dashShare')?.addEventListener('change', refresh);
  $('dashAuto')?.addEventListener('change', toggleAuto);
})();

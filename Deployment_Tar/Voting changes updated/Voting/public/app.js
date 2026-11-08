// Shared front-end: live clock, countdown, confetti, count-up. No dependencies.
(function () {
  let offset = 0;      // serverNow - clientNow, keeps the clock honest
  let closeAt = null;
  let electionStatus = null;

  async function loadInfo() {
    try {
      const d = await (await fetch('/info')).json();
      offset = d.now - Date.now();
      closeAt = d.close_at;
      electionStatus = d.status;
      document.querySelectorAll('[data-title]').forEach((e) => (e.textContent = d.title));
      document.querySelectorAll('[data-desc]').forEach((e) => {
        e.textContent = d.description || '';
        e.style.display = d.description ? '' : 'none';
      });
      renderCountdown();
    } catch { /* offline/kiosk — clock still ticks on client time */ }
  }
  const serverNow = () => Date.now() + offset;

  function tick() {
    const clock = document.getElementById('clock');
    if (clock) clock.textContent = new Date(serverNow()).toLocaleTimeString();
    renderCountdown();
  }

  function renderCountdown() {
    const el = document.getElementById('countdown');
    if (!el) return;
    if (electionStatus === 'closed') { el.style.display = ''; el.textContent = 'Voting closed'; el.className = 'badge bad'; return; }
    if (electionStatus === 'held') { el.style.display = ''; el.textContent = 'Voting on hold'; el.className = 'badge warn'; return; }
    if (!closeAt) { el.style.display = 'none'; return; }
    el.style.display = '';
    const ms = closeAt - serverNow();
    if (ms <= 0) { el.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="/icons.svg#lock"></use></svg> Voting closed'; el.className = 'badge bad'; return; }
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    el.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="/icons.svg#clock"></use></svg> ' + (h ? h + 'h ' : '') + String(m).padStart(2, '0') + 'm ' + String(ss).padStart(2, '0') + 's';
    el.className = 'badge ' + (ms < 5 * 60000 ? 'warn pulse' : 'open');
  }

  // Lightweight canvas confetti burst.
  window.confetti = function (opts) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    opts = opts || {};
    const count = opts.count || 150;
    const c = document.createElement('canvas');
    c.className = 'confetti-canvas';
    c.width = innerWidth; c.height = innerHeight;
    document.body.appendChild(c);
    const ctx = c.getContext('2d');
    const cols = ['#1e40af', '#3b82f6', '#0f9d6e', '#f59e0b', '#ef4444', '#8b5cf6'];
    const P = [];
    for (let i = 0; i < count; i++) P.push({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.32,
      vx: (Math.random() - 0.5) * 13, vy: Math.random() * -15 - 4, g: 0.3 + Math.random() * 0.2,
      s: 5 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35, col: cols[i % cols.length],
    });
    let frame = 0;
    (function anim() {
      frame++;
      ctx.clearRect(0, 0, c.width, c.height);
      let alive = false;
      for (const p of P) {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vx *= 0.99;
        if (p.y < c.height + 20) alive = true;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.globalAlpha = Math.max(0, 1 - frame / 170); ctx.fillStyle = p.col;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
      }
      if (alive && frame < 180) requestAnimationFrame(anim); else c.remove();
    })();
  };

  // Animated number count-up.
  window.countUp = function (el, to, dur) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to; return; }
    dur = dur || 900;
    const start = performance.now();
    (function step(t) {
      const k = Math.min(1, (t - start) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    })(start);
  };

  document.addEventListener('DOMContentLoaded', () => {
    loadInfo();
    setInterval(tick, 1000);
    setInterval(loadInfo, 20000);
  });
})();

// Small shared UI helpers. API failures are returned to callers, including uncertain writes.
window.UI = {
  escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); },
  async request(url, options = {}) {
    try {
      const response = await fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, status: 0, uncertain: true, data: { error: 'Connection interrupted. Check the connection and try again.' } };
    }
  },
  portrait(candidate) {
    const name = String(candidate.name || '?');
    const initials = name.trim().split(/\s+/).slice(0, 2).map(p => Array.from(p)[0]).join('').toUpperCase();
    const photo = /^\/uploads\/[a-f0-9-]+\.webp$/.test(candidate.photo || '') ? candidate.photo : null;
    return `<span class="portrait" aria-hidden="true"><span>${UI.escape(initials)}</span>${photo ? `<img src="${photo}" alt="" loading="lazy">` : ''}</span>`;
  },
  async photoData(file) {
    if (!file) return null;
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('Choose a JPEG, PNG, or WebP photo under 2 MB.');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read this photo.'));
      reader.readAsDataURL(file);
    });
  },
  async preview(input, target) {
    try {
      const data = await UI.photoData(input.files[0]);
      target.replaceChildren();
      if (data) { const img = document.createElement('img'); img.className = 'photo-preview'; img.alt = 'Selected candidate photo preview'; img.src = `data:${input.files[0].type};base64,${data}`; target.append(img); }
    } catch (error) { target.textContent = error.message; input.value = ''; }
  },
  download(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
};
document.addEventListener('error', event => {
  if (event.target.matches?.('.portrait img')) event.target.remove();
}, true);

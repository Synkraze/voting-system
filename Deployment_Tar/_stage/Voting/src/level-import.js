// Candidate files use Name,Department, Level N. The first comma separates the
// name; the final level is part of the description, even when it has commas.
function levelFromDescription(description) {
  const match = /(?:^|,)\s*Level\s+(\d+)\s*$/i.exec(description || '');
  const level = match ? Number(match[1]) : null;
  return Number.isSafeInteger(level) && level >= 1 && level <= 100 ? level : null;
}

function parseLevelCandidates(csv) {
  if (typeof csv !== 'string' || !csv.trim()) throw new Error('Choose a candidate CSV file.');
  const groups = new Map();
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    const name = line.slice(0, comma < 0 ? undefined : comma).trim();
    const description = comma < 0 ? '' : line.slice(comma + 1).trim();
    if (i === 0 && /^name$/i.test(name) && /^description/i.test(description)) continue;
    const level = levelFromDescription(description);
    if (!name || name.length > 120 || description.length > 1000 || level === null) {
      throw new Error(`Line ${i + 1}: use Name,Description, Level N (name max 120; description max 1,000 characters).`);
    }
    if (!groups.has(level)) groups.set(level, []);
    groups.get(level).push({ name, description });
  }
  if (!groups.size) throw new Error('The CSV contains no candidates.');
  return [...groups].sort((a, b) => a[0] - b[0]);
}

module.exports = { parseLevelCandidates, levelFromDescription };

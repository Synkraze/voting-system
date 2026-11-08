// Level-only ballot eligibility. A position's `elig_levels` is a CSV of the
// student levels allowed to vote in it (e.g. '6,7'); NULL/empty means the
// position is open to every voter. A voter with no level set can only see
// unrestricted positions.
function parseLevels(csv) {
  if (!csv) return [];
  return String(csv).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
}

function positionAllowsLevel(eligLevels, level) {
  const allowed = parseLevels(eligLevels);
  if (!allowed.length) return true; // open to all
  return level != null && allowed.includes(Number(level));
}

// Normalize admin input ('6,7' | '6, 7' | [6,7]) to a clean CSV or null.
function normalizeLevels(input) {
  if (input == null || input === '') return null;
  const list = Array.isArray(input) ? input : String(input).split(',');
  const levels = [...new Set(list.map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 100))];
  return levels.length ? levels.sort((a, b) => a - b).join(',') : null;
}

module.exports = { parseLevels, positionAllowsLevel, normalizeLevels };

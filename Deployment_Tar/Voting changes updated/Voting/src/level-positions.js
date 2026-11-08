const { levelFromDescription } = require('./level-import');

// Convert positions whose existing candidates have a final "Level N" field
// into one stored position per level. Call inside a locked transaction. Ballot
// rows are signed with their position ID, so a split is unsafe after voting.
async function splitLevelPositions(c, onlyPositionId = null) {
  const status = (await c.query("SELECT value FROM meta WHERE key = 'status'")).rows[0]?.value;
  const voted = (await c.query('SELECT 1 FROM ballot LIMIT 1')).rowCount > 0;
  if (status === 'closed' || voted) return { changed: false, blocked: true };

  const positions = (await c.query('SELECT position_id, title FROM position ORDER BY seq, position_id')).rows;
  const titles = new Map(positions.map(p => [p.title.toLowerCase(), p.position_id]));
  const ordered = [];
  let changed = false, skipped = false;

  for (const position of positions) {
    if (onlyPositionId !== null && position.position_id !== onlyPositionId) {
      ordered.push(position.position_id);
      continue;
    }
    const candidates = (await c.query('SELECT candidate_id, description FROM candidate WHERE position_id = $1 ORDER BY candidate_id', [position.position_id])).rows;
    const candidateLevels = candidates.map(candidate => levelFromDescription(candidate.description));
    if (!candidateLevels.some(level => level !== null)) {
      ordered.push(position.position_id);
      continue;
    }
    if (candidateLevels.some(level => level === null)) {
      skipped = true;
      ordered.push(position.position_id);
      continue;
    }
    const groups = new Map();
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i], level = candidateLevels[i];
      if (!groups.has(level)) groups.set(level, []);
      groups.get(level).push(candidate.candidate_id);
    }

    const base = position.title.replace(/\s+—\s+Level\s+\d+\s*$/i, '').trim();
    const levels = [...groups.keys()].sort((a, b) => a - b);
    const targetTitles = levels.map(level => `${base} — Level ${level}`);
    if (targetTitles.some(title => title.length > 120 || (titles.has(title.toLowerCase()) && titles.get(title.toLowerCase()) !== position.position_id))) {
      skipped = true;
      ordered.push(position.position_id);
      continue;
    }

    const suffix = /\s+—\s+Level\s+(\d+)\s*$/i.exec(position.title);
    const namedLevel = suffix ? Number(suffix[1]) : null;
    const keepLevel = namedLevel !== null && groups.has(namedLevel) ? namedLevel : levels[0];
    const keepTitle = `${base} — Level ${keepLevel}`;
    if (position.title !== keepTitle) {
      await c.query('UPDATE position SET title = $1 WHERE position_id = $2', [keepTitle, position.position_id]);
      titles.delete(position.title.toLowerCase());
      titles.set(keepTitle.toLowerCase(), position.position_id);
      changed = true;
    }
    for (const level of levels) {
      if (level === keepLevel) {
        ordered.push(position.position_id);
        continue;
      }
      const title = `${base} — Level ${level}`;
      const created = (await c.query('INSERT INTO position (title, seq) VALUES ($1, 0) RETURNING position_id', [title])).rows[0];
      await c.query('UPDATE candidate SET position_id = $1 WHERE candidate_id = ANY($2)', [created.position_id, groups.get(level)]);
      titles.set(title.toLowerCase(), created.position_id);
      ordered.push(created.position_id);
      changed = true;
    }
  }
  if (changed) {
    for (let i = 0; i < ordered.length; i++) await c.query('UPDATE position SET seq = $1 WHERE position_id = $2', [i, ordered[i]]);
  }
  return { changed, blocked: false, skipped };
}

module.exports = { splitLevelPositions };

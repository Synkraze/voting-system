// Official UWL RAK Student Council ballot arrangement. Candidate rows are
// moved between positions so existing photos and candidate IDs are preserved.
const GROUPS = [
  {
    title: 'President',
    office: 'president',
    candidates: ['Aviraj Garg', 'Basima Abdul Jaleel', 'Badusha Mohammed Rafi'],
  },
  {
    title: 'Vice President – General',
    office: 'vp-general',
    candidates: ['Mohamed Meshaal Mehboob', 'Nethra Babu', 'Abdul Hadi Shafeer', 'Zac Immanuel Binu', 'Ruda Hussain'],
  },
  {
    title: 'Vice President – Women Empowerment',
    office: 'vp-women',
    candidates: ['Anugraha Jayan', 'Anuclae Ranjan', 'Faiha Mubarak', 'Maryam Haris', 'R. Sai Sahana', 'Samiha Shiekh Abdullah'],
  },
  {
    title: 'Assistant Vice President – Sports — Level 4 Male',
    office: 'avp-sports',
    candidates: ['Muhammed Rabei Riyas', 'Mohammed Safwan Sajeerkhan', 'Rayan Muhammad Shafeeque'],
  },
  {
    title: 'Assistant Vice President – Sports — Level 4 Female',
    office: 'avp-sports',
    candidates: ['Fathima Muhammad', 'Nimna Manoharan', 'Arafah Cheick Davoudou'],
  },
  {
    title: 'Assistant Vice President – Sports — Level 5 or 6 Male',
    office: 'avp-sports',
    candidates: ['Mohammed Ifad'],
  },
  {
    title: 'Assistant Vice President – Sports — Level 5 or 6 Female',
    office: 'avp-sports',
    candidates: ['Farhana Jamiludheen'],
  },
  {
    title: 'Assistant Vice President – Culture — Level 4',
    office: 'avp-culture',
    candidates: ['Arjun Shibu', 'Johan Thomas Mathews', 'Shaza Zahir', 'Zoha Aziz'],
  },
  {
    title: 'Assistant Vice President – Culture — Level 5 or 6',
    office: 'avp-culture',
    candidates: ['Mahasuk Rahman Shahul Hameed', 'Shameera Kamaludeen'],
  },
];

const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[–—-]+/g, ' ').replace(/\s+/g, ' ');

function positionOffice(title) {
  const value = normalize(title)
    .replace(/^vp\b/, 'vice president')
    .replace(/^avp\b/, 'assistant vice president');
  if (/^president(?:\s|$)/.test(value)) return 'president';
  if (/^vice president\s+general(?:\s|$)/.test(value)) return 'vp-general';
  if (/^vice president\s+women empowerment(?:\s|$)/.test(value)) return 'vp-women';
  if (/^assistant vice president\s+sports(?:\s|$)/.test(value)) return 'avp-sports';
  if (/^assistant vice president\s+culture(?:\s|$)/.test(value)) return 'avp-culture';
  return null;
}

function fullPositionTitle(title) {
  const office = positionOffice(title);
  if (!office) return String(title || '').trim();
  const value = String(title || '').trim();
  const suffixMatch = /(?:\s+[—–-]\s+)(Level\s+.+)$/i.exec(value);
  const suffix = suffixMatch ? ` — ${suffixMatch[1]}` : '';
  const base = {
    president: 'President',
    'vp-general': 'Vice President – General',
    'vp-women': 'Vice President – Women Empowerment',
    'avp-sports': 'Assistant Vice President – Sports',
    'avp-culture': 'Assistant Vice President – Culture',
  }[office];
  return base + suffix;
}

function officialImportGroups(title, candidates) {
  const office = positionOffice(title);
  if (!office) return null;
  const expected = GROUPS.filter((group) => group.office === office);
  const supplied = new Map(candidates.map((candidate) => [normalize(candidate.name), candidate]));
  const expectedNames = expected.flatMap((group) => group.candidates);
  const missing = expectedNames.filter((name) => !supplied.has(normalize(name)));
  const unexpected = candidates.filter((candidate) => !expectedNames.some((name) => normalize(name) === normalize(candidate.name)));
  if (missing.length || unexpected.length || supplied.size !== candidates.length) {
    const details = [];
    if (missing.length) details.push(`missing: ${missing.join(', ')}`);
    if (unexpected.length) details.push(`unexpected: ${unexpected.map((candidate) => candidate.name).join(', ')}`);
    if (supplied.size !== candidates.length) details.push('duplicate candidate names');
    throw new Error(`Candidate list does not match the official ${fullPositionTitle(title)} arrangement (${details.join('; ')}).`);
  }
  return expected.map((group) => ({
    title: group.title,
    candidates: group.candidates.map((name) => supplied.get(normalize(name))),
  }));
}

async function arrangeOfficialBallot(c) {
  const positions = (await c.query('SELECT position_id, title, seq FROM position ORDER BY seq, position_id')).rows;
  const candidates = (await c.query(`
    SELECT c.candidate_id, c.position_id, c.name, c.seq, p.title AS position_title
    FROM candidate c JOIN position p ON p.position_id = c.position_id
    ORDER BY c.seq, c.candidate_id
  `)).rows;
  const detected = candidates.some((candidate) => GROUPS.some((group) => group.candidates.some((name) => normalize(name) === normalize(candidate.name))));
  if (!detected) return { detected: false, changed: false };
  const alreadyArranged = positions.length === GROUPS.length && GROUPS.every((group, groupIndex) => {
    const position = positions[groupIndex];
    const members = candidates.filter((candidate) => candidate.position_id === position.position_id)
      .sort((a, b) => a.seq - b.seq || a.candidate_id - b.candidate_id);
    return position.title === group.title && position.seq === groupIndex &&
      members.length === group.candidates.length &&
      members.every((candidate, candidateIndex) => normalize(candidate.name) === normalize(group.candidates[candidateIndex]) && candidate.seq === candidateIndex);
  });
  if (alreadyArranged) return { detected: true, changed: false, groups: GROUPS.length };
  if ((await c.query('SELECT 1 FROM ballot LIMIT 1')).rowCount) return { detected: true, changed: false, blocked: true };

  const byName = new Map();
  for (const candidate of candidates) {
    const key = normalize(candidate.name);
    if (byName.has(key)) return { detected: true, changed: false, incomplete: true, reason: `Duplicate candidate: ${candidate.name}` };
    byName.set(key, candidate);
  }
  const allExpected = GROUPS.flatMap((group) => group.candidates);
  const missing = allExpected.filter((name) => !byName.has(normalize(name)));
  if (missing.length) return { detected: true, changed: false, incomplete: true, reason: `Missing candidates: ${missing.join(', ')}` };
  const expectedKeys = new Set(allExpected.map(normalize));
  const unexpected = candidates.filter((candidate) => positionOffice(candidate.position_title) && !expectedKeys.has(normalize(candidate.name)));
  if (unexpected.length) return { detected: true, changed: false, incomplete: true, reason: `Unexpected candidates: ${unexpected.map((candidate) => candidate.name).join(', ')}` };

  const available = new Map();
  for (const position of positions) {
    const office = positionOffice(position.title);
    if (!office) continue;
    if (!available.has(office)) available.set(office, []);
    available.get(office).push(position);
  }
  const used = new Set();
  let changed = false;
  for (let groupIndex = 0; groupIndex < GROUPS.length; groupIndex++) {
    const group = GROUPS[groupIndex];
    let position = (available.get(group.office) || []).find((item) => !used.has(item.position_id));
    if (!position) {
      position = (await c.query('INSERT INTO position (title, seq) VALUES ($1, $2) RETURNING position_id, title, seq', [group.title, groupIndex])).rows[0];
      changed = true;
    }
    used.add(position.position_id);
    if (position.title !== group.title || position.seq !== groupIndex) {
      await c.query('UPDATE position SET title = $1, seq = $2 WHERE position_id = $3', [group.title, groupIndex, position.position_id]);
      changed = true;
    }
    for (let candidateIndex = 0; candidateIndex < group.candidates.length; candidateIndex++) {
      const candidate = byName.get(normalize(group.candidates[candidateIndex]));
      if (candidate.position_id !== position.position_id || candidate.seq !== candidateIndex) {
        await c.query('UPDATE candidate SET position_id = $1, seq = $2 WHERE candidate_id = $3', [position.position_id, candidateIndex, candidate.candidate_id]);
        changed = true;
      }
    }
  }
  const obsolete = positions.filter((position) => positionOffice(position.title) && !used.has(position.position_id));
  for (const position of obsolete) {
    await c.query('DELETE FROM position WHERE position_id = $1', [position.position_id]);
    changed = true;
  }
  return { detected: true, changed, groups: GROUPS.length };
}

module.exports = { GROUPS, positionOffice, fullPositionTitle, officialImportGroups, arrangeOfficialBallot };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseLevelCandidates } = require('../src/level-import');
const { GROUPS, fullPositionTitle, officialImportGroups, arrangeOfficialBallot } = require('../src/official-ballot');

const ROOT = path.join(__dirname, '..');
function candidates(file) {
  return parseLevelCandidates(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8')).flatMap(([, rows]) => rows);
}

test('position abbreviations expand to their full forms', () => {
  assert.equal(fullPositionTitle('VP General'), 'Vice President – General');
  assert.equal(fullPositionTitle('VP Women Empowerment — Level 4'), 'Vice President – Women Empowerment — Level 4');
  assert.equal(fullPositionTitle('AVP Sports — Level 5'), 'Assistant Vice President – Sports — Level 5');
  assert.equal(fullPositionTitle('AVP Culture'), 'Assistant Vice President – Culture');
});

test('Women Empowerment candidates remain one position in the supplied order', () => {
  const groups = officialImportGroups('VP Women Empowerment', candidates('candidates-3-vp-women-empowerment.csv'));
  assert.deepEqual(groups.map((group) => group.title), ['Vice President – Women Empowerment']);
  assert.deepEqual(groups[0].candidates.map((candidate) => candidate.name), [
    'Anugraha Jayan', 'Anuclae Ranjan', 'Faiha Mubarak', 'Maryam Haris', 'R. Sai Sahana', 'Samiha Shiekh Abdullah',
  ]);
});

test('Culture candidates use the two approved groups and order', () => {
  const groups = officialImportGroups('AVP Culture', candidates('candidates-4-avp-culture.csv'));
  assert.deepEqual(groups.map((group) => [group.title, group.candidates.map((candidate) => candidate.name)]), [
    ['Assistant Vice President – Culture — Level 4', ['Arjun Shibu', 'Johan Thomas Mathews', 'Shaza Zahir', 'Zoha Aziz']],
    ['Assistant Vice President – Culture — Level 5 or 6', ['Mahasuk Rahman Shahul Hameed', 'Shameera Kamaludeen']],
  ]);
});

test('an already arranged ballot remains valid after votes have been cast', async () => {
  const positions = GROUPS.map((group, index) => ({ position_id: index + 1, title: group.title, seq: index }));
  let nextId = 1;
  const members = GROUPS.flatMap((group, groupIndex) => group.candidates.map((name, candidateIndex) => ({
    candidate_id: nextId++, position_id: groupIndex + 1, position_title: group.title,
    name, seq: candidateIndex,
  })));
  const client = { query: async (sql) => {
    if (sql.includes('FROM position')) return { rows: positions };
    if (sql.includes('FROM candidate')) return { rows: members };
    throw new Error('An arranged ballot should not be changed or blocked by existing votes.');
  } };
  assert.deepEqual(await arrangeOfficialBallot(client), { detected: true, changed: false, groups: 9 });
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseLevelCandidates } = require('../src/level-import');

test('all supplied candidate files split by their stated levels', () => {
  const expected = [[3], [5], [3, 2, 1], [3, 3], [3, 4, 1]];
  for (let i = 1; i <= 5; i++) {
    const file = fs.readdirSync(path.join(__dirname, '..', 'data')).find(name => name.startsWith(`candidates-${i}-`));
    const groups = parseLevelCandidates(fs.readFileSync(path.join(__dirname, '..', 'data', file), 'utf8'));
    assert.deepEqual(groups.map(([, candidates]) => candidates.length), expected[i - 1]);
    assert.ok(groups.every(([level, candidates]) => candidates.every(c => c.description.endsWith(`Level ${level}`))));
  }
});

test('invalid level rows reject the whole import', () => {
  assert.throws(() => parseLevelCandidates('Alice,Science, Level 4\nBob,Science'), /Line 2/);
  assert.throws(() => parseLevelCandidates('Alice,Science, Level 0'), /Line 1/);
});

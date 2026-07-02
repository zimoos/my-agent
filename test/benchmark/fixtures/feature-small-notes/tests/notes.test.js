const test = require('node:test');
const assert = require('node:assert/strict');
const { listNotes, searchNotes } = require('../src/notes');

test('searchNotes returns notes matching title or body case-insensitively', () => {
  assert.equal(typeof searchNotes, 'function');
  const results = searchNotes(listNotes(), 'deploy');
  assert.deepEqual(results.map((note) => note.id), ['n2', 'n3']);
});

test('searchNotes trims query and returns empty array when nothing matches', () => {
  assert.deepEqual(searchNotes(listNotes(), '  roadmap  ').map((note) => note.id), ['n1']);
  assert.deepEqual(searchNotes(listNotes(), 'missing'), []);
});

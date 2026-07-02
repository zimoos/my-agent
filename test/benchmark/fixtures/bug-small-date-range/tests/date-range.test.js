const test = require('node:test');
const assert = require('node:assert/strict');
const { enumerateDays } = require('../src/date-range');

test('enumerateDays includes both start and end date', () => {
  assert.deepEqual(enumerateDays('2026-07-01', '2026-07-03'), [
    '2026-07-01',
    '2026-07-02',
    '2026-07-03',
  ]);
});

test('enumerateDays supports a single-day range', () => {
  assert.deepEqual(enumerateDays('2026-07-02', '2026-07-02'), ['2026-07-02']);
});

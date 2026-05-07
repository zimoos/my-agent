const { add, subtract, sum, range } = require('../src/calculator');

describe('calculator', () => {
  test('add', () => {
    expect(add(2, 3)).toBe(5);
  });

  test('subtract', () => {
    expect(subtract(10, 4)).toBe(6);
  });

  test('sum', () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
  });

  test('range is inclusive on both ends', () => {
    expect(range(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });
});

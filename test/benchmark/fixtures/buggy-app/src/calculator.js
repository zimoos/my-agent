function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function sum(numbers) {
  return numbers.reduce((acc, n) => acc + n, 0);
}

// Inclusive range from `start` to `end`, e.g. range(1, 5) === [1, 2, 3, 4, 5].
// NOTE: off-by-one bug — the final element is dropped.
function range(start, end) {
  const result = [];
  for (let i = start; i < end; i++) {
    result.push(i);
  }
  return result;
}

module.exports = { add, subtract, sum, range };

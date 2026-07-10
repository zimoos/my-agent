const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorld, getBlock, generateChunkKey } = require('../src/world');
const { createPlayer, movePlayer } = require('../src/player');
const { serializeGame, deserializeGame } = require('../src/save');

test('createWorld generates deterministic terrain chunks', () => {
  const a = createWorld({ seed: 42, radius: 1 });
  const b = createWorld({ seed: 42, radius: 1 });

  assert.deepEqual(a.chunks, b.chunks);
  assert.ok(Object.keys(a.chunks).includes(generateChunkKey(0, 0)));
  assert.equal(typeof getBlock(a, 0, 0, 0), 'string');
});

test('player movement is bounded by world collision and updates position', () => {
  const world = createWorld({ seed: 7, radius: 1 });
  const player = createPlayer({ x: 0, y: 4, z: 0 });
  const moved = movePlayer(world, player, { dx: 1, dy: 0, dz: 0 });

  assert.notEqual(moved.x, player.x);
  assert.ok(Number.isFinite(moved.x));
  assert.ok(Number.isFinite(moved.y));
  assert.ok(Number.isFinite(moved.z));
});

test('save/load preserves world seed, chunks, and player state', () => {
  const world = createWorld({ seed: 99, radius: 1 });
  const player = createPlayer({ x: 2, y: 5, z: -1 });
  const encoded = serializeGame({ world, player });
  const decoded = deserializeGame(encoded);

  assert.deepEqual(decoded.world.seed, 99);
  assert.deepEqual(decoded.world.chunks, world.chunks);
  assert.deepEqual(decoded.player, player);
});

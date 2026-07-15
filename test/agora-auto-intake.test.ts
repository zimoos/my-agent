import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgoraBatchTargets, planAgoraAutoIntake } from '../src/provider/agora-auto-intake.js';

const memory = { id: 'memory-a', name: '产品记忆', base_model_id: 'base-a', head_patch_id: 'patch-a', status: 'available' };
const patch = { id: 'patch-a', name: '产品记忆@v1', base_model_id: 'base-a', family: 'memory-a', version: 'v1', mountable: true, status: 'available', memory_id: 'memory-a' };

test('auto intake plans only the uncheckpointed range after four user turns', () => {
  const messages = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old answer' },
    ...Array.from({ length: 4 }, (_, index) => [
      { role: 'user', content: `fact ${index}` },
      { role: 'assistant', content: `answer ${index}` },
    ]).flat(),
  ];
  const plan = planAgoraAutoIntake({
    messages,
    checkpointEnd: 2,
    profile: {
      id: 'profile-a',
      name: 'project',
      base_model_id: 'base-a',
      active_memory_patch_ids: ['patch-a'],
      auto_intake_target_memory_ids: ['memory-a'],
      auto_intake_policy: { enabled: true, min_user_turns: 4, min_pending_tokens: 2000 },
      status: 'available',
    },
    memories: [memory],
    patches: [patch],
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.sourceStart, 2);
  assert.equal(plan.sourceEnd, messages.length);
  assert.equal(plan.pendingUserTurns, 4);
  assert.deepEqual(plan.targets, [{
    mode: 'increment',
    memory_id: 'memory-a',
    expected_parent_patch_id: 'patch-a',
    output_name: '产品记忆@v2',
  }]);
});

test('auto intake never guesses a target and can trigger on pending token threshold', () => {
  const base = {
    id: 'profile-a',
    name: 'project',
    base_model_id: 'base-a',
    active_memory_patch_ids: ['patch-a'],
    auto_intake_policy: { enabled: true, min_user_turns: 4, min_pending_tokens: 100 },
    status: 'available',
  };
  const noTarget = planAgoraAutoIntake({
    messages: [{ role: 'user', content: 'x'.repeat(1000) }],
    checkpointEnd: 0,
    profile: base,
    memories: [memory],
    patches: [patch],
  });
  assert.equal(noTarget.ready, false);
  assert.equal(noTarget.reason, 'no_explicit_targets');
  const tokenReady = planAgoraAutoIntake({
    messages: [{ role: 'user', content: 'x'.repeat(1000) }],
    checkpointEnd: 0,
    profile: { ...base, auto_intake_target_memory_ids: ['memory-a'] },
    memories: [memory],
    patches: [patch],
  });
  assert.equal(tokenReady.ready, true);
  assert.ok(tokenReady.pendingTokens >= 100);
});

test('auto checkpoint can advance only when every target is completed or noop', () => {
  const successful = classifyAgoraBatchTargets([
    { id: 'a', batch_id: 'b', mode: 'increment', output_name: 'a', status: 'completed' },
    { id: 'c', batch_id: 'b', mode: 'increment', output_name: 'c', status: 'noop' },
  ]);
  assert.equal(successful.terminal, true);
  assert.equal(successful.blockers.length, 0);
  const partial = classifyAgoraBatchTargets([
    { id: 'a', batch_id: 'b', mode: 'increment', output_name: 'a', status: 'completed' },
    { id: 'c', batch_id: 'b', mode: 'increment', output_name: 'c', status: 'conflict', error: { retryable: true } },
    { id: 'd', batch_id: 'b', mode: 'increment', output_name: 'd', status: 'failed', error: { retryable: false } },
  ]);
  assert.equal(partial.terminal, true);
  assert.equal(partial.blockers.length, 2);
  assert.deepEqual(partial.retryable.map((target) => target.id), ['c']);
});

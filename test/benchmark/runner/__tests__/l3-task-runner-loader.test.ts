import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadL3Task } from '../l3-task-runner.js';

test('loadL3Task accepts legacy objective_checks cmd alias', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'l3-loader-test-'));
  const file = path.join(dir, 'task.yaml');
  writeFileSync(
    file,
    `
id: "L3-999"
title: "legacy cmd"
level: "L3"
category: "test"
weight: 1
fixture:
  project: "x"
prompt: "do it"
rubric_points:
  - "works"
objective_checks:
  - cmd: "npm test"
    expected_exit: 2
    weight_into: "Correctness"
no_modify_files:
  - "tests/example.test.js"
runtime:
  timeout_sec: 10
  runs: 1
`,
    'utf8',
  );

  const task = loadL3Task(file);
  assert.equal(task.objectiveChecks[0].command, 'npm test');
  assert.equal(task.objectiveChecks[0].expectedExit, 2);
  assert.equal(task.objectiveChecks[0].weightInto, 'Correctness');
  assert.deepEqual(task.noModifyFiles, ['tests/example.test.js']);
});

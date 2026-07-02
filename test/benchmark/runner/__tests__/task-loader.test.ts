import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadTasks } from '../task-loader.js';

// ─── Test fixture utilities ───

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-loader-test-'));
}

function writeYaml(dir: string, relPath: string, body: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
}

function mkFixtureDir(root: string, name: string): string {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const VALID_L1_YAML = `
id: L1-001
title: readme summary
level: L1
category: doc
weight: 10
user_input: 请阅读 README 并总结三点
fixture:
  project: demo-project
attachments:
  - type: image
    path: screenshots/home.png
requires:
  - vision
behavior_expectations:
  - 信息不足时先提问
judge_rubric:
  - 是否稳定保留上下文
runtime:
  timeout_sec: 30
  runs: 5
  max_rounds: null
  layer: L2
hard_assertions:
  - type: tool_called
    tool: readFile
  - type: final_text_min_chars
    chars: 20
    chinese: true
  - type: context_window_min
    min: 1000000
  - type: no_silent_tool_streak
    max: 4
  - type: progress_count_min
    min: 1
  - type: task_failure_has_actionable_summary
soft_assertions:
  - type: final_text_min_len
    chars: 100
    weight: 1.0
  - type: duration_max
    ms: 20000
    weight: 0.5
  - type: llm_judge
    rubric: "是否覆盖了三个要点"
    weight: 2.0
`;

const VALID_L0_YAML = `
id: L0-001
title: smoke-no-tool
level: L0
category: smoke
weight: 5
user_input: 回答 hello
runtime:
  timeout_sec: 10
  runs: 1
  max_rounds: 1
  layer: L2
hard_assertions:
  - type: final_text_contains
    contains: hello
`;

const VALID_L2_MULTIROUND_YAML = `
id: L2-001
title: multi-turn edit
level: L2
category: edit
weight: 20
fixture:
  project: demo-project
  setup:
    - npm install
rounds:
  - user: 打开 index.js
    judge_rubric:
      - 必须先读文件
    attachments:
      - path: screenshots/code.png
    expect:
      tool_calls_include:
        - readFile
  - user: 在顶部加一行注释
runtime:
  timeout_sec: 120
  runs: 5
  max_rounds: 8
  layer: L2
hard_assertions:
  - type: tool_called
    tool_matches: "^(readFile|writeFile)$"
  - type: file_content
    path: index.js
    contains: "//"
  - type: exit_code
    cmd: "npm test"
    code: 0
soft_assertions:
  - type: tool_call_count_max
    max: 10
    weight: 1.0
reference:
  reference_rounds: 4
  human_time_sec: 180
  claude_code_score: 85
dim_weights:
  ToolAcc: 1.0
  TaskDone: 2.0
`;

// ─── Tests ───

test('loads valid L0/L1/L2 tasks with camelCase conversion', () => {
  const root = mkTmp();
  const fixturesRoot = path.join(root, 'fixtures');
  mkFixtureDir(fixturesRoot, 'demo-project');
  const tasksDir = path.join(root, 'tasks');
  writeYaml(tasksDir, 'L0/smoke.yaml', VALID_L0_YAML);
  writeYaml(tasksDir, 'L1/readme.yaml', VALID_L1_YAML);
  writeYaml(tasksDir, 'L2/multi.yaml', VALID_L2_MULTIROUND_YAML);

  const { tasks, errors } = loadTasks({
    tasksDir,
    fixturesDir: fixturesRoot,
  });

  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 3);

  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

  // L0 single turn, no fixture
  const l0 = byId['L0-001'];
  assert.equal(l0.level, 'L0');
  assert.equal(l0.userInput, '回答 hello');
  assert.equal(l0.fixture, undefined);
  assert.equal(l0.runtime.timeoutSec, 10);
  assert.equal(l0.runtime.runs, 1);
  assert.equal(l0.runtime.maxRounds, 1);
  assert.equal(l0.runtime.layer, 'L2');
  assert.equal(l0.hardAssertions.length, 1);
  assert.deepEqual(l0.hardAssertions[0], { type: 'final_text_contains', contains: 'hello' });
  assert.equal(l0.softAssertions.length, 0);

  // L1 single turn with fixture
  const l1 = byId['L1-001'];
  assert.equal(l1.userInput, '请阅读 README 并总结三点');
  assert.equal(l1.fixture?.project, 'demo-project');
  assert.deepEqual(l1.requires, ['vision']);
  assert.deepEqual(l1.behaviorExpectations, ['信息不足时先提问']);
  assert.deepEqual(l1.judgeRubric, ['是否稳定保留上下文']);
  assert.deepEqual(l1.attachments, [
    { type: 'image', path: 'screenshots/home.png', mime: undefined },
  ]);
  assert.equal(l1.runtime.maxRounds, null);
  assert.equal(l1.hardAssertions.length, 6);
  assert.equal(l1.softAssertions.length, 3);
  // camelCase-converted final_text_min_chars
  const minChars = l1.hardAssertions.find((h) => h.type === 'final_text_min_chars');
  assert.ok(minChars);
  if (minChars.type === 'final_text_min_chars') {
    assert.equal(minChars.chars, 20);
    assert.equal(minChars.chinese, true);
  }
  assert.deepEqual(
    l1.hardAssertions.find((h) => h.type === 'context_window_min'),
    { type: 'context_window_min', min: 1000000 }
  );
  assert.deepEqual(
    l1.hardAssertions.find((h) => h.type === 'no_silent_tool_streak'),
    { type: 'no_silent_tool_streak', max: 4 }
  );
  assert.deepEqual(
    l1.hardAssertions.find((h) => h.type === 'progress_count_min'),
    { type: 'progress_count_min', min: 1 }
  );
  assert.deepEqual(
    l1.hardAssertions.find((h) => h.type === 'task_failure_has_actionable_summary'),
    { type: 'task_failure_has_actionable_summary' }
  );

  // L2 multi-round + setup + dimWeights + reference
  const l2 = byId['L2-001'];
  assert.equal(l2.userInput, undefined);
  assert.equal(l2.rounds?.length, 2);
  assert.deepEqual(l2.rounds?.[0].judgeRubric, ['必须先读文件']);
  assert.deepEqual(l2.rounds?.[0].attachments, [
    { type: 'image', path: 'screenshots/code.png', mime: undefined },
  ]);
  assert.deepEqual(l2.rounds?.[0].expect?.toolCallsInclude, ['readFile']);
  assert.deepEqual(l2.fixture?.setup, ['npm install']);
  assert.equal(l2.reference?.referenceRounds, 4);
  assert.equal(l2.reference?.humanTimeSec, 180);
  assert.equal(l2.reference?.claudeCodeScore, 85);
  assert.equal(l2.dimWeights?.ToolAcc, 1.0);
  assert.equal(l2.dimWeights?.TaskDone, 2.0);
  // event_sequence not used here, but exit_code should be preserved
  const exitCode = l2.hardAssertions.find((h) => h.type === 'exit_code');
  assert.ok(exitCode);
  if (exitCode.type === 'exit_code') {
    assert.equal(exitCode.cmd, 'npm test');
    assert.equal(exitCode.code, 0);
  }
  // sourcePath recorded
  assert.ok(l2.sourcePath.endsWith('multi.yaml'));
});

test('aggregates errors from multiple bad files (no throw)', () => {
  const root = mkTmp();
  const tasksDir = path.join(root, 'tasks');

  // Bad id format
  writeYaml(
    tasksDir,
    'L1/bad-id.yaml',
    `
id: BAD-ID
title: t
level: L1
category: c
weight: 5
user_input: hi
runtime:
  timeout_sec: 10
  runs: 1
  max_rounds: null
  layer: L2
hard_assertions:
  - type: final_text_contains
    contains: hi
`
  );

  // Unknown assertion type
  writeYaml(
    tasksDir,
    'L1/bad-assertion.yaml',
    `
id: L1-002
title: t
level: L1
category: c
weight: 5
user_input: hi
runtime:
  timeout_sec: 10
  runs: 1
  max_rounds: null
  layer: L2
hard_assertions:
  - type: nonsense_assertion
    foo: bar
`
  );

  // Missing hard_assertions
  writeYaml(
    tasksDir,
    'L1/no-hard.yaml',
    `
id: L1-003
title: t
level: L1
category: c
weight: 5
user_input: hi
runtime:
  timeout_sec: 10
  runs: 1
  max_rounds: null
  layer: L2
hard_assertions: []
`
  );

  // Both user_input and rounds
  writeYaml(
    tasksDir,
    'L1/both-input.yaml',
    `
id: L1-004
title: t
level: L1
category: c
weight: 5
user_input: hi
rounds:
  - user: hello
runtime:
  timeout_sec: 10
  runs: 1
  max_rounds: null
  layer: L2
hard_assertions:
  - type: final_text_contains
    contains: x
`
  );

  // Weight 0
  writeYaml(
    tasksDir,
    'L1/zero-weight.yaml',
    `
id: L1-005
title: t
level: L1
category: c
weight: 0
user_input: hi
runtime:
  timeout_sec: 10
  runs: 1
  max_rounds: null
  layer: L2
hard_assertions:
  - type: final_text_contains
    contains: x
`
  );

  // Fixture project missing (no fixturesDir configured)
  writeYaml(
    tasksDir,
    'L1/missing-fixture.yaml',
    `
id: L1-006
title: t
level: L1
category: c
weight: 5
user_input: hi
fixture:
  project: does-not-exist
runtime:
  timeout_sec: 10
  runs: 1
  max_rounds: null
  layer: L2
hard_assertions:
  - type: final_text_contains
    contains: x
`
  );

  const { tasks, errors } = loadTasks({ tasksDir });
  assert.equal(tasks.length, 0, 'tasks must be empty when any errors exist');
  assert.ok(errors.length >= 6, `expected ≥6 aggregated errors, got ${errors.length}: ${errors.join('\n')}`);
  const joined = errors.join('\n');
  assert.match(joined, /bad-id\.yaml.*BAD-ID/);
  assert.match(joined, /bad-assertion\.yaml.*nonsense_assertion/);
  assert.match(joined, /no-hard\.yaml.*hard_assertions/);
  assert.match(joined, /both-input\.yaml.*cannot define both/);
  assert.match(joined, /zero-weight\.yaml.*weight/);
  assert.match(joined, /missing-fixture\.yaml.*does-not-exist/);
});

test('filters by --level and --task', () => {
  const root = mkTmp();
  const fixturesRoot = path.join(root, 'fixtures');
  mkFixtureDir(fixturesRoot, 'demo-project');
  const tasksDir = path.join(root, 'tasks');
  writeYaml(tasksDir, 'L0/smoke.yaml', VALID_L0_YAML);
  writeYaml(tasksDir, 'L1/readme.yaml', VALID_L1_YAML);
  writeYaml(tasksDir, 'L2/multi.yaml', VALID_L2_MULTIROUND_YAML);

  const onlyL1 = loadTasks({ tasksDir, fixturesDir: fixturesRoot, filterLevel: 'L1' });
  assert.deepEqual(onlyL1.errors, []);
  assert.equal(onlyL1.tasks.length, 1);
  assert.equal(onlyL1.tasks[0].id, 'L1-001');

  const onlyTask = loadTasks({ tasksDir, fixturesDir: fixturesRoot, filterTask: 'L2-001' });
  assert.deepEqual(onlyTask.errors, []);
  assert.equal(onlyTask.tasks.length, 1);
  assert.equal(onlyTask.tasks[0].id, 'L2-001');

  const noMatch = loadTasks({
    tasksDir,
    fixturesDir: fixturesRoot,
    filterLevel: 'L1',
    filterTask: 'L2-001',
  });
  assert.deepEqual(noMatch.errors, []);
  assert.equal(noMatch.tasks.length, 0);
});

test('default load ignores L3 directory because L3 uses a separate schema', () => {
  const root = mkTmp();
  const fixturesRoot = path.join(root, 'fixtures');
  mkFixtureDir(fixturesRoot, 'demo-project');
  const tasksDir = path.join(root, 'tasks');
  writeYaml(tasksDir, 'L1/readme.yaml', VALID_L1_YAML);
  writeYaml(
    tasksDir,
    'L3/l3-task.yaml',
    `
id: L3-001
title: separate schema
level: L3
category: implement
weight: 1
prompt: "L3 tasks do not use user_input"
runtime:
  timeout_sec: 10
  runs: 1
`
  );

  const { tasks, errors } = loadTasks({ tasksDir, fixturesDir: fixturesRoot });
  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'L1-001');
});

test('resolves fixture from e2eFixturesDir when fixturesDir misses', () => {
  const root = mkTmp();
  const fixturesRoot = path.join(root, 'fixtures'); // empty
  const e2eFixtures = path.join(root, 'e2e-fixtures');
  fs.mkdirSync(fixturesRoot, { recursive: true });
  mkFixtureDir(e2eFixtures, 'shared-fixture');
  const tasksDir = path.join(root, 'tasks');
  writeYaml(
    tasksDir,
    'L1/use-shared.yaml',
    `
id: L1-010
title: shared
level: L1
category: c
weight: 5
user_input: hi
fixture:
  project: shared-fixture
runtime:
  timeout_sec: 10
  runs: 1
  max_rounds: null
  layer: L2
hard_assertions:
  - type: final_text_contains
    contains: x
`
  );

  const { tasks, errors } = loadTasks({
    tasksDir,
    fixturesDir: fixturesRoot,
    e2eFixturesDir: e2eFixtures,
  });
  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].fixture?.project, 'shared-fixture');
});

test('detects duplicate ids across files', () => {
  const root = mkTmp();
  const fixturesRoot = path.join(root, 'fixtures');
  mkFixtureDir(fixturesRoot, 'demo-project');
  const tasksDir = path.join(root, 'tasks');
  writeYaml(tasksDir, 'L1/a.yaml', VALID_L1_YAML);
  writeYaml(tasksDir, 'L1/b.yaml', VALID_L1_YAML);

  const { tasks, errors } = loadTasks({ tasksDir, fixturesDir: fixturesRoot });
  assert.equal(tasks.length, 0);
  assert.ok(errors.some((e) => /duplicate id "L1-001"/.test(e)), errors.join('\n'));
});

test('rejects YAML with snake_case key but wrong type', () => {
  const root = mkTmp();
  const fixturesRoot = path.join(root, 'fixtures');
  mkFixtureDir(fixturesRoot, 'demo-project');
  const tasksDir = path.join(root, 'tasks');

  // runtime.runs as float (not integer)
  writeYaml(
    tasksDir,
    'L1/bad-runs.yaml',
    `
id: L1-020
title: t
level: L1
category: c
weight: 5
user_input: hi
fixture:
  project: demo-project
runtime:
  timeout_sec: 10
  runs: 2.5
  max_rounds: null
  layer: L2
hard_assertions:
  - type: final_text_contains
    contains: x
`
  );

  const { tasks, errors } = loadTasks({ tasksDir, fixturesDir: fixturesRoot });
  assert.equal(tasks.length, 0);
  assert.ok(errors.some((e) => /runtime\.runs/.test(e)), errors.join('\n'));
});

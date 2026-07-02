const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWorkspace,
  findTask,
  moveTask,
  projectSummary,
} = require('../src/projects');

test('moveTask moves a task between projects and preserves task data', () => {
  const workspace = createWorkspace();
  const moved = moveTask(workspace, 't1', 'doing');

  assert.equal(moved.id, 't1');
  assert.equal(findTask(workspace, 't1').project.id, 'doing');
  assert.equal(workspace.projects.find((p) => p.id === 'backlog').tasks.some((t) => t.id === 't1'), false);
});

test('moveTask rejects missing task or project without changing workspace', () => {
  const workspace = createWorkspace();
  assert.throws(() => moveTask(workspace, 'missing', 'doing'), /task not found/);
  assert.throws(() => moveTask(workspace, 't1', 'missing'), /project not found/);
  assert.equal(findTask(workspace, 't1').project.id, 'backlog');
});

test('projectSummary returns task counts by status', () => {
  const workspace = createWorkspace();
  moveTask(workspace, 't1', 'doing');
  const summary = projectSummary(workspace);

  assert.deepEqual(summary.find((p) => p.id === 'backlog'), {
    id: 'backlog',
    name: 'Backlog',
    total: 1,
    open: 0,
    done: 1,
  });
  assert.deepEqual(summary.find((p) => p.id === 'doing'), {
    id: 'doing',
    name: 'Doing',
    total: 2,
    open: 2,
    done: 0,
  });
});

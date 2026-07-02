function createWorkspace() {
  return {
    projects: [
      {
        id: 'backlog',
        name: 'Backlog',
        tasks: [
          { id: 't1', title: 'Write spec', status: 'open' },
          { id: 't2', title: 'Fix smoke test', status: 'done' },
        ],
      },
      {
        id: 'doing',
        name: 'Doing',
        tasks: [{ id: 't3', title: 'Implement runner', status: 'open' }],
      },
    ],
  };
}

function findTask(workspace, taskId) {
  for (const project of workspace.projects) {
    const task = project.tasks.find((item) => item.id === taskId);
    if (task) return { project, task };
  }
  return null;
}

function addTask(workspace, projectId, task) {
  const project = workspace.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  project.tasks.push({ ...task });
  return task;
}

module.exports = { createWorkspace, findTask, addTask };

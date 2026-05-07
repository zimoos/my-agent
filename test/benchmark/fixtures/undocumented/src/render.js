function renderList(todos) {
  if (!todos || todos.length === 0) {
    return '(no todos)';
  }
  return todos
    .map((t) => `${t.done ? '[x]' : '[ ]'} #${t.id} ${t.text}`)
    .join('\n');
}

module.exports = { renderList };

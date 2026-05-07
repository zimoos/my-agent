#!/usr/bin/env node
const { parseArgs } = require('./args');
const { createStore } = require('./store');
const { addTodo, listTodos, completeTodo, removeTodo } = require('./commands');
const { renderList } = require('./render');

function main(argv) {
  const { command, options } = parseArgs(argv.slice(2));
  const store = createStore(options.file);

  switch (command) {
    case 'add': {
      const todo = addTodo(store, options.text);
      console.log(`Added #${todo.id}: ${todo.text}`);
      return 0;
    }
    case 'list': {
      const todos = listTodos(store, options.filter);
      console.log(renderList(todos));
      return 0;
    }
    case 'done': {
      const ok = completeTodo(store, options.id);
      console.log(ok ? `Marked #${options.id} done` : `No todo #${options.id}`);
      return ok ? 0 : 1;
    }
    case 'rm': {
      const ok = removeTodo(store, options.id);
      console.log(ok ? `Removed #${options.id}` : `No todo #${options.id}`);
      return ok ? 0 : 1;
    }
    default:
      console.error('Usage: todo <add|list|done|rm> [args]');
      return 2;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };

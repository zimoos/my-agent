function addTodo(store, text) {
  const state = store.read();
  const todo = { id: state.nextId, text: String(text || ''), done: false };
  state.todos.push(todo);
  state.nextId += 1;
  store.write(state);
  return todo;
}

function listTodos(store, filter) {
  const state = store.read();
  if (filter === 'open') return state.todos.filter((t) => !t.done);
  if (filter === 'done') return state.todos.filter((t) => t.done);
  return state.todos;
}

function completeTodo(store, id) {
  const state = store.read();
  const numId = Number(id);
  const todo = state.todos.find((t) => t.id === numId);
  if (!todo) return false;
  todo.done = true;
  store.write(state);
  return true;
}

function removeTodo(store, id) {
  const state = store.read();
  const numId = Number(id);
  const before = state.todos.length;
  state.todos = state.todos.filter((t) => t.id !== numId);
  if (state.todos.length === before) return false;
  store.write(state);
  return true;
}

module.exports = { addTodo, listTodos, completeTodo, removeTodo };

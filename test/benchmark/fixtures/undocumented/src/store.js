const fs = require('fs');
const path = require('path');

function createStore(fileName) {
  const file = path.resolve(process.cwd(), fileName);

  function read() {
    if (!fs.existsSync(file)) {
      return { nextId: 1, todos: [] };
    }
    const raw = fs.readFileSync(file, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return { nextId: 1, todos: [] };
    }
  }

  function write(state) {
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  }

  return { file, read, write };
}

module.exports = { createStore };

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = { file: '.todos.json' };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--file') {
      options.file = rest[++i];
    } else if (token === '--filter') {
      options.filter = rest[++i];
    } else if (token === '--id') {
      options.id = rest[++i];
    } else if (!options.text && (command === 'add')) {
      options.text = token;
    } else if (!options.id && (command === 'done' || command === 'rm')) {
      options.id = token;
    }
  }

  return { command, options };
}

module.exports = { parseArgs };

const NOTES = [
  { id: 'n1', title: 'Roadmap', body: 'Plan multi-turn benchmark work' },
  { id: 'n2', title: 'Deploy checklist', body: 'Run build before deploy' },
  { id: 'n3', title: 'Incident', body: 'Deploy failed because logs were not checked' },
];

function listNotes() {
  return NOTES.map((note) => ({ ...note }));
}

module.exports = { listNotes };

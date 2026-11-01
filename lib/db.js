// Tiny JSON-file store. Shape mirrors the future Postgres/Supabase tables
// (templates, renders) so it can be swapped out without touching callers.
import fs from 'node:fs';
import path from 'node:path';

export function createDb(dataDir) {
  const file = path.join(dataDir, 'db.json');
  let state = { templates: [], renders: [] };
  if (fs.existsSync(file)) state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };

  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  };

  return {
    list: (table) => state[table],
    get: (table, id) => state[table].find((r) => r.id === id),
    insert(table, row) { state[table].push(row); save(); return row; },
    update(table, id, patch) {
      const row = this.get(table, id);
      if (!row) return null;
      Object.assign(row, patch);
      save();
      return row;
    },
  };
}

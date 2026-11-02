// Tiny JSON-file store. Table shapes mirror the future Postgres/Supabase schema so the
// store can be swapped without touching callers.
//   engine:  templates, personas, hybrids, renders
//   rooms:   rooms, members, faces, likes, ledger, sources (videos waiting to be trimmed)
import fs from 'node:fs';
import path from 'node:path';

const TABLES = ['templates', 'renders', 'personas', 'hybrids', 'rooms', 'members', 'faces', 'likes', 'ledger', 'sources'];

export function createDb(dataDir) {
  const file = path.join(dataDir, 'db.json');
  let state = Object.fromEntries(TABLES.map((t) => [t, []]));
  if (fs.existsSync(file)) state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };

  let timer = null;
  const flush = () => {
    timer = null;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  };
  // Coalesce bursts of writes (polling + progress updates) into one disk write.
  const save = () => { if (!timer) timer = setTimeout(flush, 50); };
  process.on('exit', () => { if (timer) { clearTimeout(timer); flush(); } });

  return {
    list: (table) => state[table],
    get: (table, id) => state[table].find((r) => r.id === id),
    find: (table, pred) => state[table].find(pred),
    where: (table, pred) => state[table].filter(pred),
    insert(table, row) { state[table].push(row); save(); return row; },
    update(table, id, patch) {
      const row = this.get(table, id);
      if (!row) return null;
      Object.assign(row, patch);
      save();
      return row;
    },
    remove(table, pred) { const before = state[table].length; state[table] = state[table].filter((r) => !pred(r)); if (state[table].length !== before) save(); },
    flush,
  };
}

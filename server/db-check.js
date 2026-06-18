import { databaseStatus, getDb } from './db.js';

try {
  const db = getDb();
  const integrity = db.pragma('integrity_check', { simple: true });
  const foreignKeys = db.pragma('foreign_key_check');
  const status = databaseStatus(db);
  if (integrity !== 'ok') throw new Error(`SQLite integrity_check failed: ${integrity}`);
  if (foreignKeys.length) throw new Error(`SQLite foreign_key_check failed with ${foreignKeys.length} issue(s).`);
  console.log(JSON.stringify({ ok: true, database: status }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

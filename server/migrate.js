import { databaseStatus, getDb, runMigrations } from './db.js';

try {
  const db = getDb();
  runMigrations(db);
  console.log(`Database migrated. Schema version ${databaseStatus(db).schemaVersion}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

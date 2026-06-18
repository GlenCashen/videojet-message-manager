import { databasePath, databaseStatus, getDb } from './db.js';

try {
  const status = databaseStatus(getDb());
  console.log(JSON.stringify({
    path: databasePath(),
    ...status
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

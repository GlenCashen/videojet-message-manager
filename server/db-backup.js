import fs from 'node:fs/promises';
import path from 'node:path';
import { databasePath, getDb } from './db.js';

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

try {
  const backupDir = path.join(process.cwd(), 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const target = path.join(backupDir, `videojet-${stamp()}.db`);
  await getDb().backup(target);
  console.log(`Backed up ${databasePath()} to ${target}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

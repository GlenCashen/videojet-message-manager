import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as initialSchema from './migrations/001_initial_schema.js';
import * as indexes from './migrations/002_indexes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'videojet.db');
const migrations = [initialSchema, indexes].sort((a, b) => a.version - b.version);

let connection = null;

function databasePath() {
  return process.env.DB_PATH || DEFAULT_DB_PATH;
}

function openDatabase(filePath = databasePath()) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new Database(filePath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (error) {
    throw new Error(`Unable to open SQLite database: ${error.message}`);
  }
}

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function runMigrations(db = getDb()) {
  ensureMigrationTable(db);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      insert.run(migration.version, migration.name, new Date().toISOString());
    });
    try {
      apply();
    } catch (error) {
      throw new Error(`Migration ${migration.version} ${migration.name} failed: ${error.message}`);
    }
  }
}

function getDb() {
  if (!connection) {
    connection = openDatabase();
    runMigrations(connection);
  }
  return connection;
}

function transaction(callback, db = getDb()) {
  return db.transaction(callback);
}

function schemaVersion(db = getDb()) {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  return row?.version || 0;
}

function databaseStatus(db = getDb()) {
  const journalMode = db.pragma('journal_mode', { simple: true });
  const foreignKeys = Boolean(db.pragma('foreign_keys', { simple: true }));
  return {
    connected: true,
    journalMode,
    foreignKeys,
    schemaVersion: schemaVersion(db)
  };
}

function closeDatabase() {
  if (!connection) return;
  connection.close();
  connection = null;
}

export {
  databasePath,
  databaseStatus,
  getDb,
  migrations,
  openDatabase,
  runMigrations,
  schemaVersion,
  transaction,
  closeDatabase
};

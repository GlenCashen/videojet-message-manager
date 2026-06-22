import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as initialSchema from './migrations/001_initial_schema.js';
import * as indexes from './migrations/002_indexes.js';
import * as printerModels from './migrations/003_printer_models.js';
import * as printerReadbackMode from './migrations/004_printer_readback_mode.js';
import * as printerArchiving from './migrations/005_printer_archiving.js';
import * as batchReleases from './migrations/007_batch_releases.js';
import * as releaseReviewClaims from './migrations/008_release_review_claims.js';
import * as releaseExecutionTargets from './migrations/009_release_execution_targets.js';
import * as releaseRunningState from './migrations/010_release_running_state.js';
import * as messageFormatRules from './migrations/011_message_format_rules.js';
import * as resetDevelopmentMasters from './migrations/012_reset_development_masters.js';
import * as printerUserFields from './migrations/013_printer_user_fields.js';
import * as canonicalPrinterFields from './migrations/014_canonical_printer_fields.js';
import * as packagingCategories from './migrations/015_packaging_categories.js';
import * as removeRetiredSchema from './migrations/017_remove_retired_schema.js';
import * as printerAgentJobs from './migrations/018_printer_agent_jobs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'videojet.db');
const migrations = [
  initialSchema, indexes, printerModels, printerReadbackMode, printerArchiving,
  batchReleases, releaseReviewClaims, releaseExecutionTargets, releaseRunningState, messageFormatRules,
  resetDevelopmentMasters, printerUserFields, canonicalPrinterFields, packagingCategories, removeRetiredSchema,
  printerAgentJobs
]
  .sort((a, b) => a.version - b.version);

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

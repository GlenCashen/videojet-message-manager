import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, runMigrations } from './db.js';
import { validateMessages } from './message-store.js';
import { persistedRecordFromExpected } from './printer-state-store.js';
import { insertAuditEvents } from './repositories/audit-repository.js';
import { upsertExpectedOutput } from './repositories/expected-output-repository.js';
import { insertFaultEvents } from './repositories/fault-repository.js';
import { replaceMessages } from './repositories/message-repository.js';
import { replacePrinters, validatePrinter } from './repositories/printer-repository.js';
import { getSetting, setSetting } from './repositories/settings-repository.js';
import { replaceUserRecords } from './repositories/user-repository.js';
import { readUsers } from './user-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const MIGRATION_KEY = 'json_migration_completed';
const SHOULD_BACKUP_JSON = process.env.NODE_ENV !== 'test' || process.env.JSON_MIGRATION_BACKUP_IN_TEST === 'true';
const SOURCE_FILES = [
  'printers.json',
  'messages.json',
  'users.json',
  'fault-history.json',
  'audit-log.json',
  'printer-state.json'
];

async function readJsonIfExists(fileName, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, fileName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${fileName}: ${error.message}`);
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function backupJsonFiles(timestamp) {
  const backupDir = path.join(DATA_DIR, 'json-backup', timestamp);
  await fs.mkdir(backupDir, { recursive: true });
  const copied = [];
  for (const file of SOURCE_FILES) {
    const source = path.join(DATA_DIR, file);
    if (!(await fileExists(source))) continue;
    await fs.copyFile(source, path.join(backupDir, file));
    copied.push(file);
  }
  return { backupDir, copied };
}

function normalizeFaultEvents(source) {
  const events = Array.isArray(source?.history) ? source.history : Array.isArray(source) ? source : [];
  return events.map((event) => ({
    id: event.id,
    printerId: event.printerId,
    faultCode: event.faultCode,
    faultLabel: event.faultLabel,
    byte: event.byte,
    bit: event.bit,
    severity: event.severity || 'fault',
    event: event.event || event.eventType,
    occurredAt: event.occurredAt,
    rawStatus: event.rawStatus,
    durationMs: event.durationMs
  })).filter((event) => event.id && event.printerId && event.faultCode && event.event);
}

function normalizeAuditEvents(source) {
  const events = Array.isArray(source?.events) ? source.events : Array.isArray(source) ? source : [];
  return events.map((event) => ({
    id: event.id,
    occurredAt: event.occurredAt || event.time || event.timestamp,
    actorUserId: event.actorUserId || null,
    actorUsername: event.actorUsername || event.actor || null,
    action: event.action || event.type || 'event',
    targetType: event.targetType || null,
    targetId: event.targetId || null,
    printerId: event.printerId || event.details?.printerId || null,
    details: event.details || event,
    ipAddress: event.ipAddress || null,
    userAgent: event.userAgent || null
  })).filter((event) => event.id && event.occurredAt && event.action);
}

async function importJsonToSqlite({ force = false } = {}) {
  const db = getDb();
  runMigrations(db);
  if (getSetting(MIGRATION_KEY, db) && !force) {
    return { skipped: true, reason: 'JSON migration has already completed.' };
  }

  const printers = (await readJsonIfExists('printers.json', [])).map(validatePrinter);
  const messages = validateMessages(await readJsonIfExists('messages.json', []), { printers });
  const usersPath = path.join(DATA_DIR, 'users.json');
  const users = await readUsers(await fileExists(usersPath) ? usersPath : undefined);
  const printerState = await readJsonIfExists('printer-state.json', {});
  const faultSource = await readJsonIfExists('fault-history.json', { history: [] });
  const faultEvents = normalizeFaultEvents(faultSource);
  const auditSource = await readJsonIfExists('audit-log.json', []);
  const auditEvents = normalizeAuditEvents(auditSource);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const summary = db.transaction(() => {
    replacePrinters(printers, db);
    replaceMessages(messages, db);
    if (users.length) replaceUserRecords(users, db);
    let expectedOutputs = 0;
    for (const [printerId, record] of Object.entries(printerState || {})) {
      upsertExpectedOutput(printerId, persistedRecordFromExpected(record), db);
      expectedOutputs += 1;
    }
    insertFaultEvents(faultEvents, db);
    insertAuditEvents(auditEvents, db);
    setSetting(MIGRATION_KEY, { completedAt: new Date().toISOString() }, db);
    return {
      printers: printers.length,
      messages: messages.length,
      messageFields: messages.reduce((total, message) => total + message.fields.length, 0),
      messageAssignments: messages.reduce((total, message) => total + (message.printerAssignments || []).length, 0),
      users: users.length,
      userAssignments: users.reduce((total, user) => total + (user.printerIds || []).length, 0),
      expectedOutputs,
      faultEvents: faultEvents.length,
      auditEvents: auditEvents.length
    };
  })();

  const backup = SHOULD_BACKUP_JSON
    ? await backupJsonFiles(timestamp)
    : { backupDir: null, copied: [] };
  return { skipped: false, imported: summary, backup };
}

function printSummary(result) {
  if (result.skipped) {
    console.log(result.reason);
    return;
  }
  console.log('Imported:');
  for (const [key, value] of Object.entries(result.imported)) console.log(`  ${key}: ${value}`);
  if (result.backup.backupDir) console.log(`Backed up JSON files to: ${result.backup.backupDir}`);
  else console.log('JSON backup skipped for test environment.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  importJsonToSqlite({ force: process.argv.includes('--force') })
    .then(printSummary)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

export { importJsonToSqlite };

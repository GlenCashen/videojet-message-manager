import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DB_PATH = path.join(os.tmpdir(), `vmm-db-${process.pid}-${Date.now()}.db`);

const { closeDatabase, databaseStatus, getDb, openDatabase, runMigrations, schemaVersion } = await import('../server/db.js');
const { createSessionManager } = await import('../server/auth.js');
const { insertAuditEvent, listAuditEvents } = await import('../server/repositories/audit-repository.js');
const { upsertExpectedOutput, listExpectedOutputs } = await import('../server/repositories/expected-output-repository.js');
const { insertFaultEvents, listFaultEvents } = await import('../server/repositories/fault-repository.js');
const { insertMessageUpdateEvent } = await import('../server/repositories/message-update-repository.js');
const { upsertMessage, listMessagesForPrinter } = await import('../server/repositories/message-repository.js');
const { deletePrinter, replacePrinters, listPrinters } = await import('../server/repositories/printer-repository.js');
const { upsertUserRecord, getUserByUsername, replaceRoles, replacePrinterAssignments } = await import('../server/repositories/user-repository.js');

test.after(() => closeDatabase());

function seedPrinters(db = getDb()) {
  replacePrinters([
    {
      id: 'coder-1',
      name: 'Can Coder',
      location: 'Line 1',
      host: '127.0.0.1',
      port: 3100,
      mode: 'emulator',
      enabled: true
    }
  ], db);
}

test('database opens with pragmas and idempotent migrations', () => {
  const db = getDb();
  const before = schemaVersion(db);
  runMigrations(db);
  const status = databaseStatus(db);

  assert.equal(status.connected, true);
  assert.equal(status.foreignKeys, true);
  assert.equal(status.journalMode, 'wal');
  assert.equal(status.schemaVersion, before);
  assert.equal(status.schemaVersion, 9);
});

test('foreign keys reject orphaned assignments', () => {
  const db = getDb();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO user_printer_assignments (user_id, printer_id, created_at)
      VALUES ('missing-user', 'missing-printer', '2026-01-01T00:00:00.000Z')
    `).run();
  }, /FOREIGN KEY/);
});

test('supports fleets larger than three and archives printers without deleting audit history', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const printers = Array.from({ length: 4 }, (_, index) => ({
    id: `fleet-${index + 1}`,
    name: `Fleet Coder ${index + 1}`,
    location: 'Test line',
    host: '127.0.0.1',
    port: 3200 + index,
    mode: 'emulator',
    enabled: true
  }));
  replacePrinters(printers, db);
  assert.equal(printers.every((printer) => listPrinters(db).some((item) => item.id === printer.id)), true);

  insertAuditEvent({ action: 'archive-test', printerId: 'fleet-4', ok: true }, db);
  deletePrinter('fleet-4', db);
  assert.equal(listPrinters(db).some((printer) => printer.id === 'fleet-4'), false);
  assert.ok(db.prepare('SELECT deleted_at FROM printers WHERE id = ?').get('fleet-4').deleted_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE printer_id = ?').get('fleet-4').count, 1);
  db.close();
});

test('repositories persist printers, users, messages and expected output', () => {
  const db = getDb();
  seedPrinters(db);

  upsertUserRecord({
    id: 'user-1',
    username: 'Operator',
    displayName: 'Operator One',
    passwordHash: 'scrypt:salt:hash',
    roles: ['operator'],
    printerIds: ['coder-1']
  }, db);
  replaceRoles('user-1', ['operator', 'qa'], db);
  replacePrinterAssignments('user-1', ['coder-1'], db);

  upsertMessage({
    id: '9-month',
    displayName: '9 Month',
    enabled: true,
    fields: [
      {
        key: 'brew',
        label: 'Brew',
        printerFieldName: 'BREW',
        required: true,
        maxLength: 30
      }
    ],
    dateRule: { type: 'offset-months', months: 9 },
    previewLines: ['{{brew}}'],
    printerAssignments: [
      {
        printerId: 'coder-1',
        printerMessageName: '9 MONTH',
        enabled: true
      }
    ]
  }, db);

  upsertExpectedOutput('coder-1', {
    messageId: '9-month',
    displayName: '9 Month',
    printerMessageName: '9 MONTH',
    fields: { brew: 'ABC' },
    lines: ['ABC'],
    rendered: 'ABC',
    source: 'last-applied',
    appliedAt: '2026-01-01T00:00:00.000Z'
  }, db);

  assert.equal(listPrinters(db).length, 1);
  assert.equal(listPrinters(db)[0].model, '1620');
  assert.equal(listPrinters(db)[0].capabilities.currentMessageReadback, true);
  assert.equal(getUserByUsername('operator', db).roles.includes('qa'), true);
  assert.equal(listMessagesForPrinter('coder-1', db)[0].printerMessageName, '9 MONTH');
  assert.equal(listExpectedOutputs(db)['coder-1'].rendered, 'ABC');
});

test('fault and audit repositories query by printer and paginate', () => {
  const db = getDb();
  seedPrinters(db);

  insertFaultEvents([
    {
      id: 'fault-1',
      printerId: 'coder-1',
      faultCode: 'B1',
      faultLabel: 'Test fault',
      event: 'activated',
      occurredAt: '2026-01-01T00:00:00.000Z'
    }
  ], db);
  insertAuditEvent({
    id: 'audit-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    actorUserId: null,
    actorUsername: 'operator',
    action: 'MESSAGE_UPDATE',
    printerId: 'coder-1',
    details: { ok: true }
  }, db);

  assert.equal(listFaultEvents({ printerId: 'coder-1' }, db).length, 1);
  assert.deepEqual(
    listAuditEvents({ printerId: 'coder-1', limit: 1 }, db).map((event) => event.action),
    ['MESSAGE_UPDATE']
  );
});

test('message update events use a unique event id for repeated printer updates', () => {
  const db = getDb();
  seedPrinters(db);

  const update = {
    id: 'coder-1',
    printerId: 'coder-1',
    messageId: null,
    fields: { batch: 'ABC' },
    ok: true,
    messageMatches: true,
    checkedAt: '2026-01-01T00:00:00.000Z'
  };

  insertMessageUpdateEvent(update, { id: 'dev-user', username: 'dev-engineering', developmentIdentity: true }, db);
  insertMessageUpdateEvent(update, {}, db);

  const events = db.prepare(`
    SELECT id, printer_id
    FROM message_update_events
    WHERE printer_id = ?
  `).all('coder-1');

  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((event) => event.id)).size, 2);
});

test('SQLite-backed sessions survive a manager restart', () => {
  const db = getDb();
  seedPrinters(db);

  upsertUserRecord({
    id: 'session-user',
    username: 'session-user',
    displayName: 'Session User',
    passwordHash: 'scrypt:salt:hash',
    roles: ['viewer'],
    printerIds: ['coder-1'],
    enabled: true
  }, db);

  const firstManager = createSessionManager();
  const cookie = firstManager.create({ id: 'session-user' });
  const secondManager = createSessionManager();

  assert.equal(secondManager.read(cookie).id, 'session-user');
  secondManager.destroy(cookie);
  assert.equal(secondManager.read(cookie), null);
});

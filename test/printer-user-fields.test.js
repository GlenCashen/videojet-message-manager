import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, runMigrations } from '../server/db.js';
import {
  createPrinterUserField,
  ensurePrinterUserField,
  listPrinterUserFields,
  resolveMessageUserFields
} from '../server/repositories/printer-user-field-repository.js';

function database() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO printers (id, name, location, host, port, mode, enabled, created_at, updated_at)
    VALUES (?, ?, 'Line', '127.0.0.1', ?, 'emulator', 1, ?, ?)
  `);
  insert.run('can', 'Can Coder', 3100, now, now);
  insert.run('bottle', 'Bottle Coder', 3101, now, now);
  return db;
}

test('printer user fields support custom stored fields', () => {
  const db = database();
  const batch1 = createPrinterUserField('can', {
    key: 'batch1', label: 'Batch 1', printerFieldName: 'Batch1', required: true, maxLength: 30
  }, db);
  assert.equal(batch1.key, 'batch1');
  assert.equal(batch1.label, 'Batch 1');
  assert.equal(batch1.printerFieldName, 'Batch1');
  assert.equal(ensurePrinterUserField('can', { key: 'batch1', label: 'Batch 1', printerFieldName: 'Batch1' }, db).id, batch1.id);
  const run = createPrinterUserField('can', { key: 'run', label: 'Run code', printerFieldName: 'RUN' }, db);
  assert.equal(run.printerFieldName, 'RUN');
  assert.deepEqual(listPrinterUserFields('can', db).map((field) => field.printerFieldName), ['Batch1', 'RUN']);
  db.close();
});

test('messages can use only fields assigned to their one printer', () => {
  const db = database();
  const bottleBatch = createPrinterUserField('bottle', {
    key: 'batch', label: 'Batch', printerFieldName: 'BATCH'
  }, db);
  assert.throws(() => resolveMessageUserFields({
    fieldIds: [bottleBatch.id],
    previewLines: ['{{batch}}'],
    printerAssignments: [{ printerId: 'can', printerMessageName: 'CAN CODE', enabled: true }]
  }, db), /belong to the assigned printer/);
  assert.throws(() => resolveMessageUserFields({ printerAssignments: [] }, db), /exactly one printer/);
  db.close();
});

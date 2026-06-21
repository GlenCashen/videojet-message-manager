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

test('printer user field variations normalize to BREW, BATCH or RUN', () => {
  const db = database();
  const brew = createPrinterUserField('can', {
    key: 'brew-code', label: 'Brew number', printerFieldName: 'TBREW', required: true, maxLength: 30
  }, db);
  assert.equal(brew.key, 'brew');
  assert.equal(brew.printerFieldName, 'BREW');
  assert.equal(ensurePrinterUserField('can', { key: 'brew', label: 'Brew', printerFieldName: 'BREW' }, db).id, brew.id);
  assert.throws(() => createPrinterUserField('can', {
    key: 'custom', label: 'Custom', printerFieldName: 'CUSTOM'
  }, db), /BREW, BATCH or RUN/);
  assert.deepEqual(listPrinterUserFields('can', db).map((field) => field.printerFieldName), ['BREW']);
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

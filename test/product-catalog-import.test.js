import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../server/db.js';
import {
  buildProductCatalog,
  importProductCatalog,
  normalizeTemplate,
  readProductCatalog
} from '../server/product-catalog-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.join(__dirname, '..', 'extracted_product_masters (1).csv');
const printers = [
  { id: 'coder-1', name: 'Can Coder', enabled: true },
  { id: 'coder-2', name: 'Bottle Coder', enabled: true },
  { id: 'coder-3', name: 'Case Coder', enabled: false },
  { id: 'coder-4', name: 'Case Coder', enabled: true }
];

function seedPrinters(db) {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO printers (id, name, location, host, port, mode, enabled, created_at, updated_at)
    VALUES (?, ?, 'Line', '127.0.0.1', ?, 'emulator', ?, ?, ?)
  `);
  printers.forEach((printer, index) => insert.run(printer.id, printer.name, 3100 + index, printer.enabled ? 1 : 0, now, now));
}

test('normalizes catalog placeholders and removes format annotations', () => {
  assert.equal(normalizeTemplate('<TXXXX><batch code>'), '{{run}}{{batch}}');
  assert.equal(normalizeTemplate('BBD: <date> <time2> (DD/MM/YYYY  HH:MM:SS)'), 'BBD: {{bestBeforeDate}} {{currentTime}}');
  assert.equal(normalizeTemplate('<batch code><time> (HH:MM:SS)'), '{{batch}}{{currentTime}}');
});

test('builds every defined catalog master with line-specific primary and shared case coders', async () => {
  const rows = await readProductCatalog(csvPath);
  const catalog = buildProductCatalog(rows, printers);
  assert.equal(rows.length, 82);
  assert.equal(catalog.masters.length, 78);
  assert.equal(catalog.masters.filter((master) => master.packagingCategory === 'cans').length, 57);
  assert.equal(catalog.masters.filter((master) => master.packagingCategory === 'bottles').length, 21);
  assert.equal(catalog.skipped.length, 4);
  assert.equal(catalog.printerIds.cans, 'coder-1');
  assert.equal(catalog.printerIds.bottles, 'coder-2');
  assert.equal(catalog.printerIds.case, 'coder-4');
  assert.ok(catalog.messages.length < catalog.masters.length * 2);
  assert.ok(catalog.messages.every((message) => message.printerAssignments.length === 1));
  assert.ok(catalog.messages.every((message) => /^\w+ \d line [A-Z/]+(?: [A-Z])?$/.test(message.displayName)));
  const namesByPrinter = catalog.messages.map((message) => `${message.printerAssignments[0].printerId}:${message.displayName}`);
  assert.equal(new Set(namesByPrinter).size, namesByPrinter.length);

  const can = catalog.masters.find((master) => master.productCode === '100001413');
  assert.deepEqual(can.specification.printerConfigurations.map((configuration) => configuration.printerId), ['coder-1', 'coder-4']);
  assert.equal(can.specification.defaultBrewSheetProduct, 'WATER');
  const bottle = catalog.masters.find((master) => master.productCode === '100001660');
  assert.deepEqual(bottle.specification.printerConfigurations.map((configuration) => configuration.printerId), ['coder-2', 'coder-4']);
  assert.equal(bottle.specification.bestBeforeMonths, 0);
});

test('imports messages before masters and is idempotent', async () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  seedPrinters(db);
  const catalog = buildProductCatalog(await readProductCatalog(csvPath), printers);
  const first = importProductCatalog(catalog, { db });
  assert.equal(first.mastersCreated, 78);
  assert.equal(first.mastersUpdated, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, catalog.messages.length);
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM printer_user_fields').get().count > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_fields WHERE printer_user_field_id IS NULL').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_masters').get().count, 78);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_master_versions').get().count, 78);

  const second = importProductCatalog(catalog, { db });
  assert.equal(second.mastersCreated, 0);
  assert.equal(second.mastersUpdated, 0);
  assert.equal(second.mastersUnchanged, 78);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_master_versions').get().count, 78);
  db.close();
});

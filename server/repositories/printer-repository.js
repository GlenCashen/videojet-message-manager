import net from 'node:net';
import { getDb } from '../db.js';

function nowIso() {
  return new Date().toISOString();
}

function rowToPrinter(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    location: row.location || '',
    host: row.host,
    port: row.port,
    mode: row.mode,
    enabled: Boolean(row.enabled)
  };
}

function validatePrinter(printer) {
  if (!printer || typeof printer !== 'object' || Array.isArray(printer)) {
    throw new Error('Printer configuration must be an object.');
  }
  const id = String(printer.id || '').trim();
  const name = String(printer.name || '').trim();
  const location = String(printer.location || '').trim();
  const host = String(printer.host || '').trim();
  const port = Number(printer.port);
  const enabled = Boolean(printer.enabled);
  const mode = printer.mode === 'emulator' ? 'emulator' : 'real';

  if (!/^[a-z0-9-]{1,50}$/i.test(id)) throw new Error('Printer id must contain only letters, numbers and hyphens.');
  if (!name || name.length > 80) throw new Error('Printer name must be 1-80 characters.');
  if (location.length > 120) throw new Error('Printer location must be 120 characters or fewer.');
  if (!net.isIP(host) && host !== 'localhost') throw new Error('Printer host must be a valid IP address or localhost.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Printer port must be between 1 and 65535.');
  return { id, name, location, host, port, enabled, mode };
}

function listPrinters(db = getDb()) {
  return db.prepare('SELECT * FROM printers ORDER BY rowid').all().map(rowToPrinter);
}

function getPrinterById(id, db = getDb()) {
  return rowToPrinter(db.prepare('SELECT * FROM printers WHERE id = ?').get(id));
}

function upsertPrinter(printer, db = getDb()) {
  const value = validatePrinter(printer);
  const now = nowIso();
  db.prepare(`
    INSERT INTO printers (id, name, location, host, port, mode, enabled, created_at, updated_at)
    VALUES (@id, @name, @location, @host, @port, @mode, @enabled, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      location = excluded.location,
      host = excluded.host,
      port = excluded.port,
      mode = excluded.mode,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run({ ...value, enabled: value.enabled ? 1 : 0, now });
  return getPrinterById(value.id, db);
}

function replacePrinters(printers, db = getDb()) {
  if (!Array.isArray(printers) || printers.length > 3) throw new Error('A maximum of three printers is supported.');
  const ids = new Set(printers.map((printer) => validatePrinter(printer).id));
  if (ids.size !== printers.length) throw new Error('Printer ids must be unique.');
  const run = db.transaction(() => {
    for (const printer of printers) upsertPrinter(printer, db);
  });
  run();
  return listPrinters(db);
}

function updatePrinter(id, changes, db = getDb()) {
  const existing = getPrinterById(id, db);
  if (!existing) throw new Error(`Printer ${id} was not found.`);
  upsertPrinter({ ...existing, ...changes, id }, db);
  return listPrinters(db);
}

function disablePrinter(id, db = getDb()) {
  return updatePrinter(id, { enabled: false }, db);
}

function deletePrinter(id, db = getDb()) {
  db.prepare('DELETE FROM printers WHERE id = ?').run(id);
}

export {
  deletePrinter,
  disablePrinter,
  getPrinterById,
  listPrinters,
  replacePrinters,
  updatePrinter,
  upsertPrinter,
  validatePrinter
};

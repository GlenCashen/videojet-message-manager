const version = 4;
const name = 'printer_readback_mode';

function up(db) {
  db.exec(`
    ALTER TABLE printers
      ADD COLUMN readback_mode TEXT NOT NULL DEFAULT 'auto'
      CHECK (readback_mode IN ('auto', 'enabled', 'disabled'));
  `);
}

export { name, up, version };

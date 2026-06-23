const version = 20;
const name = 'printer_protocol';

function up(db) {
  db.exec(`
    ALTER TABLE printers
      ADD COLUMN protocol TEXT NOT NULL DEFAULT 'wsi'
      CHECK (protocol IN ('wsi', 'ngpcl'));
  `);
}

export { name, up, version };

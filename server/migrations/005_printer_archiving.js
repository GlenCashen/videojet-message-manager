const version = 5;
const name = 'printer_archiving';

function up(db) {
  db.exec(`ALTER TABLE printers ADD COLUMN deleted_at TEXT;`);
}

export { name, up, version };

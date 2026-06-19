const version = 3;
const name = 'printer_models';

function up(db) {
  db.exec(`
    ALTER TABLE printers
      ADD COLUMN model TEXT NOT NULL DEFAULT '1620'
      CHECK (model IN ('1620', '1710'));
  `);
}

export { name, up, version };

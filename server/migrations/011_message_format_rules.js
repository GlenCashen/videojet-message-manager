const version = 11;
const name = 'message_format_rules';

function up(db) {
  db.exec(`
    ALTER TABLE messages ADD COLUMN date_format TEXT NOT NULL DEFAULT 'DD/MM/YYYY';
    ALTER TABLE messages ADD COLUMN time_format TEXT NOT NULL DEFAULT 'HH:mm:ss';
  `);
}

export { name, up, version };

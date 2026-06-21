const version = 10;
const name = 'release_running_state';

function up(db) {
  db.exec(`
    ALTER TABLE batch_release_execution_targets ADD COLUMN running_at TEXT;
    ALTER TABLE batch_release_execution_targets ADD COLUMN ended_at TEXT;
  `);
}

export { name, up, version };

const version = 9;
const name = 'release_execution_targets';

function up(db) {
  db.exec(`
    CREATE TABLE batch_release_execution_targets (
      release_id TEXT NOT NULL,
      printer_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'awaiting_print_check', 'completed', 'failed')),
      applied_by_user_id TEXT,
      applied_by_username TEXT,
      applied_at TEXT,
      verified_by_user_id TEXT,
      verified_by_username TEXT,
      verified_at TEXT,
      error_message TEXT,
      result_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (release_id, printer_id),
      FOREIGN KEY (release_id) REFERENCES batch_releases(id) ON DELETE CASCADE,
      FOREIGN KEY (applied_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_release_execution_targets_printer_status
      ON batch_release_execution_targets(printer_id, status, updated_at);

    INSERT OR IGNORE INTO batch_release_execution_targets (release_id, printer_id, status, updated_at)
    SELECT br.id, json_each.value,
      CASE
        WHEN br.status = 'completed' THEN 'completed'
        WHEN br.status = 'failed' THEN 'failed'
        WHEN br.status = 'awaiting_print_check' THEN 'awaiting_print_check'
        WHEN br.status = 'applying' THEN 'applying'
        ELSE 'pending'
      END,
      br.updated_at
    FROM batch_releases br, json_each(br.printer_ids_json)
    WHERE br.status IN ('released', 'applying', 'awaiting_print_check', 'completed', 'failed');
  `);
}

export { name, up, version };

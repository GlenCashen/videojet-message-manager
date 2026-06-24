const version = 21;
const name = 'explicit_release_target_states';

function up(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_release_execution_targets_printer_status;

    ALTER TABLE batch_release_execution_targets RENAME TO batch_release_execution_targets_v20;

    CREATE TABLE batch_release_execution_targets (
      release_id TEXT NOT NULL,
      printer_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'awaiting_print_check', 'running', 'ended', 'failed')),
      applied_by_user_id TEXT,
      applied_by_username TEXT,
      applied_at TEXT,
      verified_by_user_id TEXT,
      verified_by_username TEXT,
      verified_at TEXT,
      error_message TEXT,
      result_json TEXT,
      updated_at TEXT NOT NULL,
      running_at TEXT,
      ended_at TEXT,
      PRIMARY KEY (release_id, printer_id),
      FOREIGN KEY (release_id) REFERENCES batch_releases(id) ON DELETE CASCADE,
      FOREIGN KEY (applied_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    INSERT INTO batch_release_execution_targets (
      release_id, printer_id, status, applied_by_user_id, applied_by_username, applied_at,
      verified_by_user_id, verified_by_username, verified_at, error_message, result_json,
      updated_at, running_at, ended_at
    )
    SELECT
      release_id,
      printer_id,
      CASE
        WHEN status = 'completed' AND running_at IS NOT NULL AND ended_at IS NULL THEN 'running'
        WHEN status = 'completed' THEN 'ended'
        ELSE status
      END,
      applied_by_user_id,
      applied_by_username,
      applied_at,
      verified_by_user_id,
      verified_by_username,
      verified_at,
      error_message,
      result_json,
      updated_at,
      running_at,
      ended_at
    FROM batch_release_execution_targets_v20;

    DROP TABLE batch_release_execution_targets_v20;

    CREATE INDEX idx_release_execution_targets_printer_status
      ON batch_release_execution_targets(printer_id, status, updated_at);
  `);
}

export { name, up, version };

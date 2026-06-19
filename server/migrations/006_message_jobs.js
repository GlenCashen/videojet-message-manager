const version = 6;
const name = 'message_jobs';

function up(db) {
  db.exec(`
    CREATE TABLE message_jobs (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      display_name TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      production_date TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'partial', 'failed', 'declined', 'expired')),
      created_by_user_id TEXT,
      created_by_username TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE message_job_targets (
      job_id TEXT NOT NULL,
      printer_id TEXT NOT NULL,
      printer_name TEXT NOT NULL,
      printer_message_name TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'declined', 'expired')),
      result_json TEXT,
      acted_by_user_id TEXT,
      acted_by_username TEXT,
      acted_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_id, printer_id),
      FOREIGN KEY (job_id) REFERENCES message_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (printer_id) REFERENCES printers(id),
      FOREIGN KEY (acted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_message_jobs_status_expires ON message_jobs(status, expires_at);
    CREATE INDEX idx_message_job_targets_printer_status ON message_job_targets(printer_id, status);
  `);
}

export { name, up, version };

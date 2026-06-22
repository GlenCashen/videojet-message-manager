const version = 18;
const name = 'printer_agent_jobs';

function up(db) {
  db.exec(`
    CREATE TABLE printer_agent_jobs (
      id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      printer_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'failed')),
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      claimed_by_agent_id TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (release_id) REFERENCES batch_releases(id) ON DELETE CASCADE,
      FOREIGN KEY (printer_id) REFERENCES printers(id)
    );

    CREATE UNIQUE INDEX idx_printer_agent_jobs_active_target
      ON printer_agent_jobs(release_id, printer_id)
      WHERE status IN ('queued', 'claimed');
    CREATE INDEX idx_printer_agent_jobs_claim
      ON printer_agent_jobs(status, printer_id, created_at);
  `);
}

export { name, up, version };

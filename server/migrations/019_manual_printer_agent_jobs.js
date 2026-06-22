const version = 19;
const name = 'manual_printer_agent_jobs';

function up(db) {
  db.exec(`
    DROP INDEX idx_printer_agent_jobs_active_target;
    DROP INDEX idx_printer_agent_jobs_claim;
    ALTER TABLE printer_agent_jobs RENAME TO printer_agent_jobs_v18;

    CREATE TABLE printer_agent_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL CHECK (job_type IN ('release', 'manual')),
      release_id TEXT,
      printer_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'failed')),
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      claimed_by_agent_id TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (release_id) REFERENCES batch_releases(id) ON DELETE CASCADE,
      FOREIGN KEY (printer_id) REFERENCES printers(id)
    );

    INSERT INTO printer_agent_jobs (
      id, job_type, release_id, printer_id, status, payload_json, payload_hash, context_json,
      claimed_by_agent_id, claimed_at, completed_at, result_json, created_at, updated_at
    )
    SELECT id, 'release', release_id, printer_id, status, payload_json, payload_hash, '{}',
      claimed_by_agent_id, claimed_at, completed_at, result_json, created_at, updated_at
    FROM printer_agent_jobs_v18;

    DROP TABLE printer_agent_jobs_v18;

    CREATE UNIQUE INDEX idx_printer_agent_jobs_active_target
      ON printer_agent_jobs(release_id, printer_id)
      WHERE release_id IS NOT NULL AND status IN ('queued', 'claimed');
    CREATE UNIQUE INDEX idx_printer_agent_jobs_active_manual
      ON printer_agent_jobs(printer_id)
      WHERE job_type = 'manual' AND status IN ('queued', 'claimed');
    CREATE INDEX idx_printer_agent_jobs_claim
      ON printer_agent_jobs(status, printer_id, created_at);
  `);
}

export { name, up, version };

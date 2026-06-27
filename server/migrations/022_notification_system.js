const version = 22;
const name = 'notification_system';

function up(db) {
  db.exec(`
    ALTER TABLE users
      ADD COLUMN email TEXT;

    CREATE TABLE IF NOT EXISTS notification_lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      event_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      recipient_roles_json TEXT NOT NULL DEFAULT '[]',
      recipient_user_ids_json TEXT NOT NULL DEFAULT '[]',
      recipient_emails_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notification_lists_event
      ON notification_lists(event_key, enabled);

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL,
      list_id TEXT,
      target_type TEXT,
      target_id TEXT,
      subject TEXT NOT NULL,
      recipients_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('skipped', 'sent', 'failed')),
      error_message TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      FOREIGN KEY (list_id) REFERENCES notification_lists(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event_target
      ON notification_deliveries(event_key, target_type, target_id, created_at);
  `);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO notification_lists (
      id, name, description, event_key, enabled,
      recipient_roles_json, recipient_user_ids_json, recipient_emails_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, '[]', '[]', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    'release-reviewers',
    'Release reviewers',
    'Reviewers notified when a production coding release is submitted for independent approval.',
    'release.pending_review',
    JSON.stringify(['packaging_leader', 'qa', 'admin']),
    now,
    now
  );
}

export { name, up, version };

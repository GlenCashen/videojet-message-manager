const version = 2;
const name = 'indexes';

function up(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fault_events_printer_time
      ON fault_events(printer_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_update_events_printer_time
      ON message_update_events(printer_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_time
      ON audit_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor
      ON audit_events(actor_user_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_printer_assignments_printer
      ON user_printer_assignments(printer_id);
    CREATE INDEX IF NOT EXISTS idx_message_printer_assignments_printer
      ON message_printer_assignments(printer_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
      ON sessions(expires_at);
  `);
}

export { name, up, version };

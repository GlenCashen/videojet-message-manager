const version = 1;
const name = 'initial_schema';

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
      mode TEXT NOT NULL CHECK (mode IN ('real', 'emulator')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      disabled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'qa', 'engineering', 'admin')),
      PRIMARY KEY (user_id, role),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_printer_assignments (
      user_id TEXT NOT NULL,
      printer_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, printer_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      date_rule_type TEXT,
      date_rule_months INTEGER,
      preview_lines_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_fields (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      printer_field_name TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      max_length INTEGER NOT NULL DEFAULT 50,
      transform TEXT NOT NULL DEFAULT 'uppercase' CHECK (transform IN ('uppercase', 'none')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (message_id, field_key),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_printer_assignments (
      message_id TEXT NOT NULL,
      printer_id TEXT NOT NULL,
      printer_message_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, printer_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS printer_expected_outputs (
      printer_id TEXT PRIMARY KEY,
      message_id TEXT,
      display_name TEXT,
      printer_message_name TEXT,
      fields_json TEXT NOT NULL,
      lines_json TEXT NOT NULL,
      rendered TEXT NOT NULL,
      source TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS message_update_events (
      id TEXT PRIMARY KEY,
      printer_id TEXT NOT NULL,
      message_id TEXT,
      printer_message_name TEXT,
      actor_user_id TEXT,
      actor_username TEXT,
      fields_json TEXT NOT NULL,
      field_results_json TEXT,
      message_selection_result_json TEXT,
      result TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS fault_events (
      id TEXT PRIMARY KEY,
      printer_id TEXT NOT NULL,
      fault_code TEXT NOT NULL,
      fault_label TEXT NOT NULL,
      byte INTEGER,
      bit INTEGER,
      severity TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('activated', 'cleared')),
      occurred_at TEXT NOT NULL,
      cleared_at TEXT,
      duration_ms INTEGER,
      raw_status TEXT,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      actor_user_id TEXT,
      actor_username TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      printer_id TEXT,
      details_json TEXT,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export { name, up, version };

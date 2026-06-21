const version = 7;
const name = 'batch_releases';

function up(db) {
  db.exec(`
    CREATE TABLE user_roles_v2 (
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'planner', 'packaging_leader', 'qa', 'engineering', 'admin')),
      PRIMARY KEY (user_id, role),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO user_roles_v2 (user_id, role) SELECT user_id, role FROM user_roles;
    DROP TABLE user_roles;
    ALTER TABLE user_roles_v2 RENAME TO user_roles;

    CREATE TABLE product_masters (
      id TEXT PRIMARY KEY,
      product_code TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      current_version INTEGER NOT NULL DEFAULT 1,
      next_run_number INTEGER NOT NULL CHECK (next_run_number >= 1),
      created_by_user_id TEXT,
      created_by_username TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE product_master_versions (
      id TEXT PRIMARY KEY,
      product_master_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      specification_json TEXT NOT NULL,
      created_by_user_id TEXT,
      created_by_username TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (product_master_id, version),
      FOREIGN KEY (product_master_id) REFERENCES product_masters(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE batch_releases (
      id TEXT PRIMARY KEY,
      product_master_id TEXT NOT NULL,
      product_master_version_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'draft', 'pending_review', 'released', 'rejected', 'cancelled',
        'applying', 'awaiting_print_check', 'completed', 'failed'
      )),
      brew_sheet_product TEXT NOT NULL,
      brew_number TEXT,
      planned_production_at TEXT NOT NULL,
      printer_ids_json TEXT NOT NULL,
      notes TEXT,
      run_number INTEGER,
      run_code TEXT,
      expected_output_json TEXT,
      created_by_user_id TEXT,
      created_by_username TEXT NOT NULL,
      submitted_at TEXT,
      reviewed_by_user_id TEXT,
      reviewed_by_username TEXT,
      reviewed_at TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (product_master_id) REFERENCES product_masters(id),
      FOREIGN KEY (product_master_version_id) REFERENCES product_master_versions(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_product_master_versions_master ON product_master_versions(product_master_id, version DESC);
    CREATE INDEX idx_batch_releases_status_date ON batch_releases(status, planned_production_at);
    CREATE UNIQUE INDEX idx_batch_releases_product_run
      ON batch_releases(product_master_id, run_number)
      WHERE run_number IS NOT NULL;
  `);
}

export { name, up, version };

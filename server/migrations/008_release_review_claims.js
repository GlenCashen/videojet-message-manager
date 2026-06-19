const version = 8;
const name = 'release_review_claims';

function up(db) {
  db.exec(`
    CREATE TABLE release_review_claims (
      release_id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      claimed_by_user_id TEXT,
      claimed_by_username TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (release_id) REFERENCES batch_releases(id) ON DELETE CASCADE,
      FOREIGN KEY (claimed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_release_review_claims_expiry ON release_review_claims(expires_at);
  `);
}

export { name, up, version };

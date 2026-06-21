const version = 17;
const name = 'remove_retired_schema';

function up(db) {
  db.exec(`
    DROP TABLE IF EXISTS message_job_targets;
    DROP TABLE IF EXISTS message_jobs;
  `);
  const releaseColumns = db.prepare('PRAGMA table_info(batch_releases)').all().map((column) => column.name);
  if (releaseColumns.includes('batch_number')) db.exec('ALTER TABLE batch_releases DROP COLUMN batch_number');
}

export { name, up, version };

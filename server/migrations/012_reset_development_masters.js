const version = 12;
const name = 'reset_development_masters';

function up(db) {
  db.exec(`
    DELETE FROM audit_events WHERE target_type IN ('batch-release', 'product-master');
    DELETE FROM batch_releases;
    DELETE FROM product_masters;
  `);
}

export { name, up, version };

const version = 15;
const name = 'packaging_categories';

function up(db) {
  db.exec(`
    ALTER TABLE product_masters
      ADD COLUMN packaging_category TEXT NOT NULL DEFAULT 'cans' CHECK (packaging_category IN ('cans', 'bottles'));

    ALTER TABLE batch_releases
      ADD COLUMN packaging_category TEXT NOT NULL DEFAULT 'cans' CHECK (packaging_category IN ('cans', 'bottles'));

    UPDATE product_masters
    SET packaging_category = 'bottles'
    WHERE EXISTS (
      SELECT 1
      FROM product_master_versions pmv, json_each(pmv.specification_json, '$.printerConfigurations') configuration
      JOIN printers p ON p.id = json_extract(configuration.value, '$.printerId')
      WHERE pmv.product_master_id = product_masters.id
        AND pmv.version = product_masters.current_version
        AND lower(p.name) LIKE '%bottle%'
    );

    UPDATE batch_releases
    SET packaging_category = COALESCE((
      SELECT pm.packaging_category FROM product_masters pm WHERE pm.id = batch_releases.product_master_id
    ), 'cans');

    CREATE INDEX idx_product_masters_category ON product_masters(packaging_category, display_name);
    CREATE INDEX idx_batch_releases_category_created ON batch_releases(packaging_category, created_at DESC);
  `);
}

export { name, up, version };

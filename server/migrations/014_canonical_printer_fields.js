const version = 14;
const name = 'canonical_printer_fields';

function up(db) {
  db.exec(`
    DELETE FROM batch_releases
    WHERE product_master_id IN (SELECT id FROM product_masters WHERE product_code = 'TEST');

    DELETE FROM product_masters WHERE product_code = 'TEST';
    DELETE FROM messages WHERE id = 'test' OR id LIKE 'test-%';

    UPDATE printer_user_fields
    SET field_key = 'brew', label = 'Brew code', printer_field_name = 'BREW',
        max_length = 50, transform = 'uppercase', updated_at = CURRENT_TIMESTAMP
    WHERE field_key = 'brew' OR lower(label) LIKE '%brew%' OR printer_field_name LIKE '%BREW%';

    UPDATE printer_user_fields
    SET field_key = 'batch', label = 'Batch code', printer_field_name = 'BATCH',
        max_length = 50, transform = 'uppercase', updated_at = CURRENT_TIMESTAMP
    WHERE field_key = 'batch' OR lower(label) LIKE '%batch%' OR printer_field_name LIKE '%BATCH%';

    UPDATE printer_user_fields
    SET field_key = 'run', label = 'Run code', printer_field_name = 'RUN',
        max_length = 10, transform = 'uppercase', updated_at = CURRENT_TIMESTAMP
    WHERE field_key = 'run' OR lower(label) LIKE '%run%' OR printer_field_name LIKE '%RUN%';

    DELETE FROM printer_user_fields WHERE field_key NOT IN ('brew', 'batch', 'run');
  `);
}

export { name, up, version };

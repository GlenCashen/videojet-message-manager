import crypto from 'node:crypto';

const version = 13;
const name = 'printer_user_fields';

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'field';
}

function uniqueMessageId(db, base) {
  let candidate = base.slice(0, 50).replace(/-+$/g, '');
  let index = 2;
  while (db.prepare('SELECT 1 FROM messages WHERE id = ?').get(candidate)) {
    const suffix = `-${index++}`;
    candidate = `${base.slice(0, 50 - suffix.length).replace(/-+$/g, '')}${suffix}`;
  }
  return candidate;
}

function rewriteMasterSpecifications(db, mutate) {
  const rows = db.prepare('SELECT id, specification_json FROM product_master_versions').all();
  const update = db.prepare('UPDATE product_master_versions SET specification_json = ? WHERE id = ?');
  for (const row of rows) {
    const specification = JSON.parse(row.specification_json);
    if (!mutate(specification)) continue;
    const primary = specification.printerConfigurations?.[0];
    if (primary) {
      specification.messageId = primary.messageId;
      specification.fieldMappings = primary.fieldMappings;
      specification.dateRule = primary.dateRule;
      specification.timeRule = primary.timeRule;
      specification.previewLines = primary.previewLines;
      specification.firstLineTemplate = primary.previewLines?.[0] || '';
      specification.secondLineTemplate = primary.previewLines?.[1] || '';
    }
    update.run(JSON.stringify(specification), row.id);
  }
}

function splitMultiPrinterMessages(db) {
  const messages = db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  const assignmentsFor = db.prepare('SELECT * FROM message_printer_assignments WHERE message_id = ? ORDER BY rowid');
  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, display_name, enabled, date_rule_type, date_rule_months, date_format, time_format,
      preview_lines_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertField = db.prepare(`
    INSERT INTO message_fields (
      id, message_id, field_key, label, printer_field_name, required, max_length,
      transform, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAssignment = db.prepare(`
    INSERT INTO message_printer_assignments (
      message_id, printer_id, printer_message_name, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const message of messages) {
    const assignments = assignmentsFor.all(message.id);
    for (const assignment of assignments.slice(1)) {
      const cloneId = uniqueMessageId(db, `${message.id}-${slug(assignment.printer_id)}`);
      insertMessage.run(
        cloneId, message.display_name, message.enabled, message.date_rule_type, message.date_rule_months,
        message.date_format, message.time_format, message.preview_lines_json, message.created_at, message.updated_at
      );
      const fields = db.prepare('SELECT * FROM message_fields WHERE message_id = ? ORDER BY sort_order, rowid').all(message.id);
      for (const field of fields) {
        insertField.run(
          crypto.randomUUID(), cloneId, field.field_key, field.label, field.printer_field_name,
          field.required, field.max_length, field.transform, field.sort_order, field.created_at, field.updated_at
        );
      }
      insertAssignment.run(
        cloneId, assignment.printer_id, assignment.printer_message_name, assignment.enabled,
        assignment.created_at, assignment.updated_at
      );
      db.prepare('DELETE FROM message_printer_assignments WHERE message_id = ? AND printer_id = ?')
        .run(message.id, assignment.printer_id);
      rewriteMasterSpecifications(db, (specification) => {
        let changed = false;
        for (const configuration of specification.printerConfigurations || []) {
          if (configuration.messageId === message.id && configuration.printerId === assignment.printer_id) {
            configuration.messageId = cloneId;
            changed = true;
          }
        }
        return changed;
      });
    }
  }
}

function uniqueFieldKey(db, printerId, preferred, printerFieldName) {
  const existing = db.prepare('SELECT printer_field_name FROM printer_user_fields WHERE printer_id = ? AND field_key = ?')
    .get(printerId, preferred);
  if (!existing || existing.printer_field_name === printerFieldName) return preferred;
  const base = `${preferred}-${slug(printerFieldName)}`.slice(0, 30).replace(/-+$/g, '');
  let candidate = base;
  let index = 2;
  while (db.prepare('SELECT 1 FROM printer_user_fields WHERE printer_id = ? AND field_key = ?').get(printerId, candidate)) {
    const suffix = `-${index++}`;
    candidate = `${base.slice(0, 30 - suffix.length).replace(/-+$/g, '')}${suffix}`;
  }
  return candidate;
}

function migrateFields(db) {
  const messages = db.prepare(`
    SELECT m.id, m.preview_lines_json, a.printer_id
    FROM messages m
    JOIN message_printer_assignments a ON a.message_id = m.id
    ORDER BY m.rowid
  `).all();
  const insert = db.prepare(`
    INSERT INTO printer_user_fields (
      id, printer_id, field_key, label, printer_field_name, required, max_length,
      transform, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (const message of messages) {
    const fields = db.prepare('SELECT * FROM message_fields WHERE message_id = ? ORDER BY sort_order, rowid').all(message.id);
    let previewLines = JSON.parse(message.preview_lines_json);
    let previewChanged = false;
    const renamedKeys = new Map();
    for (const field of fields) {
      const canonicalType = ['brew', 'batch', 'run'].find((type) =>
        [field.field_key, field.label, field.printer_field_name].some((value) => String(value || '').toLowerCase().includes(type))
      );
      if (!canonicalType) continue;
      const canonical = {
        brew: { key: 'brew', label: 'Brew code', printerFieldName: 'BREW', maxLength: 50 },
        batch: { key: 'batch', label: 'Batch code', printerFieldName: 'BATCH', maxLength: 50 },
        run: { key: 'run', label: 'Run code', printerFieldName: 'RUN', maxLength: 10 }
      }[canonicalType];
      let userField = db.prepare('SELECT * FROM printer_user_fields WHERE printer_id = ? AND printer_field_name = ?')
        .get(message.printer_id, canonical.printerFieldName);
      if (!userField) {
        const id = crypto.randomUUID();
        insert.run(
          id, message.printer_id, canonical.key, canonical.label, canonical.printerFieldName, field.required,
          canonical.maxLength, 'uppercase', field.sort_order, field.created_at || now, field.updated_at || now
        );
        userField = db.prepare('SELECT * FROM printer_user_fields WHERE id = ?').get(id);
      }
      db.prepare('UPDATE message_fields SET printer_user_field_id = ?, field_key = ? WHERE id = ?')
        .run(userField.id, userField.field_key, field.id);
      if (field.field_key !== userField.field_key) {
        renamedKeys.set(field.field_key, userField.field_key);
        previewLines = previewLines.map((line) => line.replaceAll(`{{${field.field_key}}}`, `{{${userField.field_key}}}`));
        previewChanged = true;
      }
    }
    if (previewChanged) {
      db.prepare('UPDATE messages SET preview_lines_json = ? WHERE id = ?').run(JSON.stringify(previewLines), message.id);
      rewriteMasterSpecifications(db, (specification) => {
        let changed = false;
        for (const configuration of specification.printerConfigurations || []) {
          if (configuration.messageId !== message.id) continue;
          configuration.previewLines = previewLines;
          configuration.fieldMappings = (configuration.fieldMappings || []).map((mapping) => ({
            ...mapping,
            fieldKey: renamedKeys.get(mapping.fieldKey) || mapping.fieldKey
          }));
          changed = true;
        }
        return changed;
      });
    }
  }
}

function up(db) {
  db.exec(`
    CREATE TABLE printer_user_fields (
      id TEXT PRIMARY KEY,
      printer_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      printer_field_name TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      max_length INTEGER NOT NULL DEFAULT 50,
      transform TEXT NOT NULL DEFAULT 'uppercase' CHECK (transform IN ('uppercase', 'none')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (printer_id, field_key),
      UNIQUE (printer_id, printer_field_name),
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_printer_user_fields_printer ON printer_user_fields(printer_id, sort_order, label);
    ALTER TABLE message_fields ADD COLUMN printer_user_field_id TEXT REFERENCES printer_user_fields(id) ON DELETE RESTRICT;
  `);
  splitMultiPrinterMessages(db);
  migrateFields(db);
  db.prepare("DELETE FROM product_masters WHERE product_code = 'TEST' AND NOT EXISTS (SELECT 1 FROM batch_releases WHERE product_master_id = product_masters.id)").run();
  db.prepare("DELETE FROM messages WHERE id IN ('test', 'test-2') AND NOT EXISTS (SELECT 1 FROM message_update_events WHERE message_id = messages.id)").run();
}

export { name, up, version };

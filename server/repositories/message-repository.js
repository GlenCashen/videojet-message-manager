import crypto from 'node:crypto';
import { getDb } from '../db.js';

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(value);
}

function messageFromRow(row, db) {
  if (!row) return null;
  const fields = db.prepare(`
    SELECT mf.*, puf.id AS user_field_id, puf.field_key AS registered_field_key,
      puf.label AS registered_label, puf.printer_field_name AS registered_printer_field_name,
      puf.required AS registered_required, puf.max_length AS registered_max_length,
      puf.transform AS registered_transform
    FROM message_fields mf
    LEFT JOIN printer_user_fields puf ON puf.id = mf.printer_user_field_id
    WHERE mf.message_id = ?
    ORDER BY mf.sort_order, mf.rowid
  `).all(row.id)
    .map((field) => ({
      userFieldId: field.user_field_id || null,
      key: field.registered_field_key || field.field_key,
      label: field.registered_label || field.label,
      printerFieldName: field.registered_printer_field_name || field.printer_field_name,
      required: Boolean(field.user_field_id ? field.registered_required : field.required),
      maxLength: field.registered_max_length || field.max_length,
      transform: field.registered_transform || field.transform
    }));
  const printerAssignments = db.prepare('SELECT * FROM message_printer_assignments WHERE message_id = ? ORDER BY rowid').all(row.id)
    .map((assignment) => ({
      printerId: assignment.printer_id,
      printerMessageName: assignment.printer_message_name,
      enabled: Boolean(assignment.enabled)
    }));
  return {
    id: row.id,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
    fields,
    dateRule: {
      type: row.date_rule_type || 'offset-months',
      months: row.date_rule_months,
      format: row.date_format || 'DD/MM/YYYY'
    },
    timeRule: { type: 'production-time', format: row.time_format || 'HH:mm:ss' },
    previewLines: parseJson(row.preview_lines_json, []),
    printerAssignments
  };
}

function listMessages(db = getDb()) {
  return db.prepare('SELECT * FROM messages ORDER BY rowid').all().map((row) => messageFromRow(row, db));
}

function getMessageByIdFromDb(id, db = getDb()) {
  return messageFromRow(db.prepare('SELECT * FROM messages WHERE id = ?').get(id), db);
}

function replaceMessageFields(message, db = getDb()) {
  const now = nowIso();
  db.prepare('DELETE FROM message_fields WHERE message_id = ?').run(message.id);
  const insert = db.prepare(`
    INSERT INTO message_fields (
      id, message_id, printer_user_field_id, field_key, label, printer_field_name, required,
      max_length, transform, sort_order, created_at, updated_at
    ) VALUES (@id, @messageId, @userFieldId, @fieldKey, @label, @printerFieldName, @required, @maxLength, @transform, @sortOrder, @now, @now)
  `);
  for (const [index, field] of (message.fields || []).entries()) {
    insert.run({
      id: `${message.id}-${field.key}-${crypto.randomUUID()}`,
      messageId: message.id,
      userFieldId: field.userFieldId || field.id || null,
      fieldKey: field.key,
      label: field.label,
      printerFieldName: field.printerFieldName,
      required: field.required === false ? 0 : 1,
      maxLength: Number(field.maxLength || 50),
      transform: field.transform || 'uppercase',
      sortOrder: index,
      now
    });
  }
}

function replaceMessageAssignments(message, db = getDb()) {
  const now = nowIso();
  db.prepare('DELETE FROM message_printer_assignments WHERE message_id = ?').run(message.id);
  const insert = db.prepare(`
    INSERT INTO message_printer_assignments (
      message_id, printer_id, printer_message_name, enabled, created_at, updated_at
    ) VALUES (@messageId, @printerId, @printerMessageName, @enabled, @now, @now)
  `);
  for (const assignment of message.printerAssignments || []) {
    insert.run({
      messageId: message.id,
      printerId: assignment.printerId,
      printerMessageName: assignment.printerMessageName,
      enabled: assignment.enabled === false ? 0 : 1,
      now
    });
  }
}

function upsertMessage(message, db = getDb()) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO messages (id, display_name, enabled, date_rule_type, date_rule_months, date_format, time_format, preview_lines_json, created_at, updated_at)
    VALUES (@id, @displayName, @enabled, @dateRuleType, @dateRuleMonths, @dateFormat, @timeFormat, @previewLinesJson, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      enabled = excluded.enabled,
      date_rule_type = excluded.date_rule_type,
      date_rule_months = excluded.date_rule_months,
      date_format = excluded.date_format,
      time_format = excluded.time_format,
      preview_lines_json = excluded.preview_lines_json,
      updated_at = excluded.updated_at
  `).run({
    id: message.id,
    displayName: message.displayName,
    enabled: message.enabled === false ? 0 : 1,
    dateRuleType: message.dateRule?.type || 'offset-months',
    dateRuleMonths: Number(message.dateRule?.months ?? 12),
    dateFormat: message.dateRule?.format || 'DD/MM/YYYY',
    timeFormat: message.timeRule?.format || 'HH:mm:ss',
    previewLinesJson: JSON.stringify(message.previewLines || []),
    now
  });
  replaceMessageFields(message, db);
  replaceMessageAssignments(message, db);
  return getMessageByIdFromDb(message.id, db);
}

function replaceMessages(messages, db = getDb()) {
  const run = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM messages').all().map((row) => row.id);
    for (const id of existing) {
      if (!messages.some((message) => message.id === id)) db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    }
    for (const message of messages) upsertMessage(message, db);
  });
  run();
  return listMessages(db);
}

function listMessagesForPrinter(printerId, db = getDb()) {
  return listMessages(db)
    .filter((message) => message.enabled)
    .map((message) => {
      const assignment = (message.printerAssignments || []).find((item) => item.enabled && item.printerId === printerId);
      return assignment ? { ...message, printerMessageName: assignment.printerMessageName, assignment } : null;
    })
    .filter(Boolean);
}

export {
  getMessageByIdFromDb,
  listMessages,
  listMessagesForPrinter,
  replaceMessageAssignments,
  replaceMessageFields,
  replaceMessages,
  upsertMessage
};

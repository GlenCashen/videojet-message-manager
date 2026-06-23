import crypto from 'node:crypto';
import { getDb } from '../db.js';

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9-]{0,29}$/;
const PRINTER_FIELD_PATTERN = /^[A-Za-z0-9 _-]{1,30}$/;
const CANONICAL_FIELDS = {
  brew: { key: 'brew', label: 'Brew code', printerFieldName: 'BREW', maxLength: 50 },
  batch: { key: 'batch', label: 'Batch code', printerFieldName: 'BATCH', maxLength: 50 },
  run: { key: 'run', label: 'Run code', printerFieldName: 'RUN', maxLength: 10 }
};

function slug(value, fallback = 'field') {
  const key = String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || fallback;
  return /^[a-z]/.test(key) ? key : `field-${key}`.slice(0, 30);
}

function canonicalType(input = {}) {
  const key = String(input.key || '').toLowerCase();
  const printerFieldName = String(input.printerFieldName || '').toLowerCase();
  return ['brew', 'batch', 'run'].find((type) => key === type || printerFieldName === type) || null;
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    printerId: row.printer_id,
    key: row.field_key,
    label: row.label,
    printerFieldName: row.printer_field_name,
    required: Boolean(row.required),
    maxLength: row.max_length,
    transform: row.transform,
    sortOrder: row.sort_order
  };
}

function normalize(input, current = {}) {
  const type = canonicalType({ ...current, ...input });
  const canonical = type ? CANONICAL_FIELDS[type] : null;
  const label = String(input.label ?? current.label ?? canonical?.label ?? '').trim();
  const key = String(input.key ?? current.key ?? canonical?.key ?? slug(label)).trim();
  const printerFieldName = String(input.printerFieldName ?? current.printerFieldName ?? canonical?.printerFieldName ?? label).trim();
  const maxLength = Number(input.maxLength ?? current.maxLength ?? canonical?.maxLength ?? 30);
  const transform = input.transform ?? current.transform ?? 'uppercase';
  if (!FIELD_KEY_PATTERN.test(key)) throw new Error('User field key must be lowercase kebab-case and at most 30 characters.');
  if (!label || label.length > 60) throw new Error('User field name must be 1-60 characters.');
  if (!PRINTER_FIELD_PATTERN.test(printerFieldName)) throw new Error('Printer field name must be printable letters, numbers, spaces, hyphens or underscores.');
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 50) throw new Error('Maximum length must be between 1 and 50.');
  if (!['uppercase', 'none'].includes(transform)) throw new Error('Unsupported user field transform.');
  return {
    key, label, printerFieldName, maxLength, transform,
    required: input.required ?? current.required ?? true,
    sortOrder: Number(input.sortOrder ?? current.sortOrder ?? 0)
  };
}

function listPrinterUserFields(printerId = null, db = getDb()) {
  const rows = printerId
    ? db.prepare('SELECT * FROM printer_user_fields WHERE printer_id = ? ORDER BY sort_order, label COLLATE NOCASE').all(printerId)
    : db.prepare('SELECT * FROM printer_user_fields ORDER BY printer_id, sort_order, label COLLATE NOCASE').all();
  return rows.map(fromRow);
}

function getPrinterUserField(id, db = getDb()) {
  return fromRow(db.prepare('SELECT * FROM printer_user_fields WHERE id = ?').get(id));
}

function createPrinterUserField(printerId, input, db = getDb()) {
  const field = normalize(input);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO printer_user_fields (
        id, printer_id, field_key, label, printer_field_name, required, max_length,
        transform, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, printerId, field.key, field.label, field.printerFieldName, field.required ? 1 : 0,
      field.maxLength, field.transform, field.sortOrder, now, now);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw new Error('That printer already has this field key or stored printer field name.');
    throw error;
  }
  return getPrinterUserField(id, db);
}

function updatePrinterUserField(id, input, db = getDb()) {
  const current = getPrinterUserField(id, db);
  if (!current) return null;
  const field = normalize(input, current);
  const usage = db.prepare('SELECT COUNT(*) AS count FROM message_fields WHERE printer_user_field_id = ?').get(id).count;
  if (usage && field.key !== current.key) throw new Error('The token key cannot change while messages use this field.');
  try {
    db.prepare(`
      UPDATE printer_user_fields SET
        field_key = ?, label = ?, printer_field_name = ?, required = ?, max_length = ?,
        transform = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `).run(field.key, field.label, field.printerFieldName, field.required ? 1 : 0, field.maxLength,
      field.transform, field.sortOrder, new Date().toISOString(), id);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw new Error('That printer already has this field key or stored printer field name.');
    throw error;
  }
  return getPrinterUserField(id, db);
}

function deletePrinterUserField(id, db = getDb()) {
  const current = getPrinterUserField(id, db);
  if (!current) return null;
  const usage = db.prepare('SELECT COUNT(*) AS count FROM message_fields WHERE printer_user_field_id = ?').get(id).count;
  if (usage) throw new Error(`User field is used by ${usage} message${usage === 1 ? '' : 's'} and cannot be deleted.`);
  db.prepare('DELETE FROM printer_user_fields WHERE id = ?').run(id);
  return current;
}

function ensurePrinterUserField(printerId, input, db = getDb()) {
  const normalized = normalize(input);
  const printerFieldName = normalized.printerFieldName;
  const existing = getPrinterUserField(
    db.prepare('SELECT id FROM printer_user_fields WHERE printer_id = ? AND printer_field_name = ?').get(printerId, printerFieldName)?.id,
    db
  );
  if (existing) return existing;
  return createPrinterUserField(printerId, normalized, db);
}

function resolveMessageUserFields(message, db = getDb()) {
  const assignments = Array.isArray(message.printerAssignments) ? message.printerAssignments : [];
  if (assignments.length !== 1) throw new Error('A message must be assigned to exactly one printer.');
  const printerId = assignments[0].printerId;
  const requested = Array.isArray(message.fieldIds)
    ? message.fieldIds.map((id) => ({ userFieldId: id }))
    : (message.fields || []);
  const renamedKeys = new Map();
  const fields = requested.map((field) => {
    const registered = field.userFieldId ? getPrinterUserField(field.userFieldId, db) : ensurePrinterUserField(printerId, field, db);
    if (!registered || registered.printerId !== printerId) throw new Error('Every message user field must belong to the assigned printer.');
    if (field.key && field.key !== registered.key) renamedKeys.set(field.key, registered.key);
    return { ...registered, userFieldId: registered.id };
  });
  if (new Set(fields.map((field) => field.id)).size !== fields.length) throw new Error('A user field can appear only once in a message.');
  const previewLines = (message.previewLines || []).map((line) => {
    let updated = line;
    for (const [from, to] of renamedKeys) updated = updated.replaceAll(`{{${from}}}`, `{{${to}}}`);
    return updated;
  });
  return { ...message, fields, previewLines };
}

export {
  createPrinterUserField,
  deletePrinterUserField,
  ensurePrinterUserField,
  getPrinterUserField,
  listPrinterUserFields,
  resolveMessageUserFields,
  updatePrinterUserField
};

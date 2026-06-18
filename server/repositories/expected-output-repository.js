import { getDb } from '../db.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    messageId: row.message_id,
    displayName: row.display_name,
    printerMessageName: row.printer_message_name,
    fields: JSON.parse(row.fields_json || '{}'),
    lines: JSON.parse(row.lines_json || '[]'),
    rendered: row.rendered,
    source: row.source,
    appliedAt: row.applied_at
  };
}

function listExpectedOutputs(db = getDb()) {
  const rows = db.prepare('SELECT * FROM printer_expected_outputs').all();
  return Object.fromEntries(rows.map((row) => [row.printer_id, rowToRecord(row)]));
}

function upsertExpectedOutput(printerId, expectedOutput, db = getDb()) {
  const now = new Date().toISOString();
  const appliedAt = expectedOutput.generatedAt || expectedOutput.appliedAt || now;
  db.prepare(`
    INSERT INTO printer_expected_outputs (
      printer_id, message_id, display_name, printer_message_name, fields_json, lines_json, rendered, source, applied_at, updated_at
    ) VALUES (@printerId, @messageId, @displayName, @printerMessageName, @fieldsJson, @linesJson, @rendered, @source, @appliedAt, @now)
    ON CONFLICT(printer_id) DO UPDATE SET
      message_id = excluded.message_id,
      display_name = excluded.display_name,
      printer_message_name = excluded.printer_message_name,
      fields_json = excluded.fields_json,
      lines_json = excluded.lines_json,
      rendered = excluded.rendered,
      source = excluded.source,
      applied_at = excluded.applied_at,
      updated_at = excluded.updated_at
  `).run({
    printerId,
    messageId: expectedOutput.messageId || null,
    displayName: expectedOutput.displayName || null,
    printerMessageName: expectedOutput.printerMessageName || null,
    fieldsJson: JSON.stringify(clone(expectedOutput.fields || {})),
    linesJson: JSON.stringify(clone(expectedOutput.lines || [])),
    rendered: expectedOutput.rendered || '',
    source: expectedOutput.source || 'last-applied',
    appliedAt,
    now
  });
}

export { listExpectedOutputs, upsertExpectedOutput };

import crypto from 'node:crypto';
import { getDb } from '../db.js';

function resultFromUpdate(update) {
  if (update.ok && update.messageMatches) return 'success';
  if (update.code === 'MESSAGE_MISMATCH' || update.messageMatches === false) return 'mismatch';
  if (update.code === 'FIELD_UPDATE_REJECTED') return 'rejected';
  if (update.communicationSucceeded === false) return 'transport_failure';
  return update.ok === false ? 'partial_failure' : 'success';
}

function insertMessageUpdateEvent(update, actor = {}, db = getDb()) {
  db.prepare(`
    INSERT INTO message_update_events (
      id, printer_id, message_id, printer_message_name, actor_user_id, actor_username,
      fields_json, field_results_json, message_selection_result_json, result, error_code, error_message, occurred_at
    ) VALUES (
      @id, @printerId, @messageId, @printerMessageName, @actorUserId, @actorUsername,
      @fieldsJson, @fieldResultsJson, @messageSelectionResultJson, @result, @errorCode, @errorMessage, @occurredAt
    )
  `).run({
    id: update.id || crypto.randomUUID(),
    printerId: update.printerId || update.id,
    messageId: update.expectedOutput?.messageId || update.messageId || null,
    printerMessageName: update.requestedMessage || update.expectedMessage || update.expectedOutput?.printerMessageName || null,
    actorUserId: actor.id || null,
    actorUsername: actor.username || null,
    fieldsJson: JSON.stringify(update.expectedOutput?.fields || update.fields || {}),
    fieldResultsJson: update.fieldResults ? JSON.stringify(update.fieldResults) : null,
    messageSelectionResultJson: update.messageSelection ? JSON.stringify({ result: update.messageSelection }) : null,
    result: resultFromUpdate(update),
    errorCode: update.code || null,
    errorMessage: update.error || null,
    occurredAt: update.checkedAt || new Date().toISOString()
  });
}

export { insertMessageUpdateEvent };

import crypto from 'node:crypto';
import { getDb } from '../db.js';

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function listFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    eventKey: row.event_key,
    enabled: Boolean(row.enabled),
    recipientRoles: parseJsonArray(row.recipient_roles_json),
    recipientUserIds: parseJsonArray(row.recipient_user_ids_json),
    recipientEmails: parseJsonArray(row.recipient_emails_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listNotificationLists({ eventKey, enabledOnly = true } = {}, db = getDb()) {
  const clauses = [];
  const params = {};
  if (eventKey) {
    clauses.push('event_key = @eventKey');
    params.eventKey = eventKey;
  }
  if (enabledOnly) clauses.push('enabled = 1');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM notification_lists
    ${where}
    ORDER BY name COLLATE NOCASE
  `).all(params).map(listFromRow);
}

function getNotificationList(id, db = getDb()) {
  return listFromRow(db.prepare('SELECT * FROM notification_lists WHERE id = ?').get(id));
}

function upsertNotificationList(list, db = getDb()) {
  const now = new Date().toISOString();
  const id = list.id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO notification_lists (
      id, name, description, event_key, enabled, recipient_roles_json,
      recipient_user_ids_json, recipient_emails_json, created_at, updated_at
    ) VALUES (@id, @name, @description, @eventKey, @enabled, @recipientRoles,
      @recipientUserIds, @recipientEmails, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      event_key = excluded.event_key,
      enabled = excluded.enabled,
      recipient_roles_json = excluded.recipient_roles_json,
      recipient_user_ids_json = excluded.recipient_user_ids_json,
      recipient_emails_json = excluded.recipient_emails_json,
      updated_at = excluded.updated_at
  `).run({
    id,
    name: String(list.name || '').trim(),
    description: String(list.description || '').trim() || null,
    eventKey: list.eventKey,
    enabled: list.enabled === false ? 0 : 1,
    recipientRoles: JSON.stringify(list.recipientRoles || []),
    recipientUserIds: JSON.stringify(list.recipientUserIds || []),
    recipientEmails: JSON.stringify(list.recipientEmails || []),
    createdAt: list.createdAt || now,
    updatedAt: now
  });
  return getNotificationList(id, db);
}

function insertNotificationDelivery(delivery, db = getDb()) {
  const now = new Date().toISOString();
  const id = delivery.id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO notification_deliveries (
      id, event_key, list_id, target_type, target_id, subject, recipients_json,
      status, error_message, created_at, sent_at
    ) VALUES (@id, @eventKey, @listId, @targetType, @targetId, @subject, @recipients,
      @status, @errorMessage, @createdAt, @sentAt)
  `).run({
    id,
    eventKey: delivery.eventKey,
    listId: delivery.listId || null,
    targetType: delivery.targetType || null,
    targetId: delivery.targetId || null,
    subject: delivery.subject,
    recipients: JSON.stringify(delivery.recipients || []),
    status: delivery.status,
    errorMessage: delivery.errorMessage || null,
    createdAt: delivery.createdAt || now,
    sentAt: delivery.sentAt || (delivery.status === 'sent' ? now : null)
  });
  return id;
}

export {
  getNotificationList,
  insertNotificationDelivery,
  listNotificationLists,
  upsertNotificationList
};

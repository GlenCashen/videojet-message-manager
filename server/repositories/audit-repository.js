import crypto from 'node:crypto';
import { getDb } from '../db.js';

function insertAuditEvent(event, db = getDb()) {
  const occurredAt = event.occurredAt || event.time || new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO audit_events (
      id, occurred_at, actor_user_id, actor_username, action, target_type, target_id, printer_id, details_json, ip_address, user_agent
    ) VALUES (@id, @occurredAt, @actorUserId, @actorUsername, @action, @targetType, @targetId, @printerId, @detailsJson, @ipAddress, @userAgent)
  `).run({
    id: event.id || crypto.randomUUID(),
    occurredAt,
    actorUserId: event.actorUserId || null,
    actorUsername: event.actorUsername || event.actor || null,
    action: event.action || 'event',
    targetType: event.targetType || null,
    targetId: event.targetId || null,
    printerId: event.printerId || null,
    detailsJson: JSON.stringify(event.details || event),
    ipAddress: event.ipAddress || null,
    userAgent: event.userAgent || null
  });
}

function insertAuditEvents(events, db = getDb()) {
  const run = db.transaction(() => {
    for (const event of events) insertAuditEvent(event, db);
  });
  run();
}

function listAuditEvents(query = {}, db = getDb()) {
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  const offset = Math.max(Number(query.offset || 0), 0);
  const clauses = [];
  const params = { limit, offset };
  for (const [key, column] of [
    ['printerId', 'printer_id'],
    ['actorUserId', 'actor_user_id'],
    ['action', 'action'],
    ['targetType', 'target_type'],
    ['targetId', 'target_id']
  ]) {
    if (query[key]) {
      clauses.push(`${column} = @${key}`);
      params[key] = query[key];
    }
  }
  if (query.from) {
    clauses.push('occurred_at >= @from');
    params.from = query.from;
  }
  if (query.to) {
    clauses.push('occurred_at <= @to');
    params.to = query.to;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM audit_events ${where}
    ORDER BY occurred_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params).map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    printerId: row.printer_id,
    details: row.details_json ? JSON.parse(row.details_json) : null,
    ipAddress: row.ip_address,
    userAgent: row.user_agent
  }));
}

export { insertAuditEvent, insertAuditEvents, listAuditEvents };

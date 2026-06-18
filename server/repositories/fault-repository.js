import { getDb } from '../db.js';

function rowToFaultEvent(row) {
  return {
    id: row.id,
    printerId: row.printer_id,
    faultCode: row.fault_code,
    faultLabel: row.fault_label,
    byte: row.byte,
    bit: row.bit,
    severity: row.severity || 'fault',
    event: row.event_type,
    occurredAt: row.occurred_at,
    clearedAt: row.cleared_at,
    durationMs: row.duration_ms,
    rawStatus: row.raw_status
  };
}

function insertFaultEvents(events, db = getDb()) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO fault_events (
      id, printer_id, fault_code, fault_label, byte, bit, severity, event_type, occurred_at, cleared_at, duration_ms, raw_status
    ) VALUES (@id, @printerId, @faultCode, @faultLabel, @byte, @bit, @severity, @event, @occurredAt, @clearedAt, @durationMs, @rawStatus)
  `);
  const run = db.transaction(() => {
    for (const event of events) insert.run({
      id: event.id,
      printerId: event.printerId,
      faultCode: event.faultCode,
      faultLabel: event.faultLabel,
      byte: event.byte ?? null,
      bit: event.bit ?? null,
      severity: event.severity || 'fault',
      event: event.event,
      occurredAt: event.occurredAt,
      clearedAt: event.event === 'cleared' ? event.occurredAt : null,
      durationMs: event.durationMs ?? null,
      rawStatus: event.rawStatus || null
    });
  });
  run();
}

function listFaultEvents({ printerId, from = null, to = null, activeOnly = false, limit = 100 } = {}, db = getDb()) {
  if (activeOnly) return [];
  const clauses = [];
  const params = {};
  if (printerId) {
    clauses.push('printer_id = @printerId');
    params.printerId = printerId;
  }
  if (from) {
    clauses.push('occurred_at >= @from');
    params.from = from;
  }
  if (to) {
    clauses.push('occurred_at <= @to');
    params.to = to;
  }
  params.limit = limit;
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM fault_events ${where} ORDER BY occurred_at DESC LIMIT @limit`).all(params).map(rowToFaultEvent);
}

function activeFaultsFromEvents(printerId = null, db = getDb()) {
  const events = listFaultEvents({ printerId, limit: 5000 }, db).reverse();
  const active = {};
  for (const event of events) {
    active[event.printerId] ||= {};
    if (event.event === 'activated') active[event.printerId][event.faultCode] = {
      printerId: event.printerId,
      faultCode: event.faultCode,
      faultLabel: event.faultLabel,
      byte: event.byte,
      bit: event.bit,
      severity: event.severity,
      activatedAt: event.occurredAt,
      rawStatus: event.rawStatus
    };
    else delete active[event.printerId][event.faultCode];
  }
  return printerId ? Object.values(active[printerId] || {}) : Object.values(active).flatMap((items) => Object.values(items));
}

export { activeFaultsFromEvents, insertFaultEvents, listFaultEvents, rowToFaultEvent };

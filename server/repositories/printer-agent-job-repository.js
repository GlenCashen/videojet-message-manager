import crypto from 'node:crypto';
import { getDb } from '../db.js';

function jobFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobType: row.job_type || 'release',
    releaseId: row.release_id || null,
    printerId: row.printer_id,
    status: row.status,
    payload: JSON.parse(row.payload_json),
    payloadHash: row.payload_hash,
    context: row.context_json ? JSON.parse(row.context_json) : {},
    claimedByAgentId: row.claimed_by_agent_id || null,
    claimedAt: row.claimed_at || null,
    completedAt: row.completed_at || null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hashPayload(payloadJson) {
  return crypto.createHash('sha256').update(payloadJson).digest('hex');
}

function enqueuePrinterAgentJob({ releaseId = null, printerId, payload, jobType = releaseId ? 'release' : 'manual', context = {} }, db = getDb()) {
  if (!['release', 'manual'].includes(jobType)) throw new Error('Printer-agent job type must be release or manual.');
  const existing = releaseId
    ? db.prepare(`SELECT * FROM printer_agent_jobs WHERE release_id = ? AND printer_id = ? AND status IN ('queued', 'claimed')`).get(releaseId, printerId)
    : db.prepare(`SELECT * FROM printer_agent_jobs WHERE printer_id = ? AND status IN ('queued', 'claimed')`).get(printerId);
  if (existing && jobType === 'manual') {
    const error = new Error('A printer job is already queued or running for this printer.');
    error.statusCode = 409;
    throw error;
  }
  if (existing) return jobFromRow(existing);
  const id = crypto.randomUUID();
  const payloadJson = JSON.stringify(payload);
  const contextJson = JSON.stringify(context || {});
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO printer_agent_jobs (
      id, job_type, release_id, printer_id, status, payload_json, payload_hash, context_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
  `).run(id, jobType, releaseId, printerId, payloadJson, hashPayload(payloadJson), contextJson, now, now);
  return jobFromRow(db.prepare('SELECT * FROM printer_agent_jobs WHERE id = ?').get(id));
}

function claimPrinterAgentJob(agentId, printerIds, db = getDb()) {
  if (!printerIds.length) return null;
  return db.transaction(() => {
    const placeholders = printerIds.map(() => '?').join(',');
    const existing = db.prepare(`
      SELECT * FROM printer_agent_jobs
      WHERE status = 'claimed' AND claimed_by_agent_id = ? AND printer_id IN (${placeholders})
      ORDER BY claimed_at, id LIMIT 1
    `).get(agentId, ...printerIds);
    if (existing) return jobFromRow(existing);
    const row = db.prepare(`
      SELECT * FROM printer_agent_jobs
      WHERE status = 'queued' AND printer_id IN (${placeholders})
      ORDER BY created_at, id LIMIT 1
    `).get(...printerIds);
    if (!row) return null;
    const now = new Date().toISOString();
    const claimed = db.prepare(`
      UPDATE printer_agent_jobs
      SET status = 'claimed', claimed_by_agent_id = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(agentId, now, now, row.id);
    if (!claimed.changes) return null;
    return jobFromRow(db.prepare('SELECT * FROM printer_agent_jobs WHERE id = ?').get(row.id));
  })();
}

function completePrinterAgentJob(id, agentId, result, db = getDb()) {
  const current = db.prepare('SELECT * FROM printer_agent_jobs WHERE id = ?').get(id);
  if (!current) return null;
  if (['completed', 'failed'].includes(current.status) && current.claimed_by_agent_id === agentId) {
    return jobFromRow(current);
  }
  if (current.status !== 'claimed' || current.claimed_by_agent_id !== agentId) {
    const error = new Error('This printer job is not claimed by the reporting agent.');
    error.statusCode = 409;
    throw error;
  }
  const succeeded = result?.ok !== false && result?.messageMatches !== false;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE printer_agent_jobs
    SET status = ?, result_json = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(succeeded ? 'completed' : 'failed', JSON.stringify(result || {}), now, now, id);
  return jobFromRow(db.prepare('SELECT * FROM printer_agent_jobs WHERE id = ?').get(id));
}

function getPrinterAgentJob(id, db = getDb()) {
  return jobFromRow(db.prepare('SELECT * FROM printer_agent_jobs WHERE id = ?').get(id));
}

export { claimPrinterAgentJob, completePrinterAgentJob, enqueuePrinterAgentJob, getPrinterAgentJob, hashPayload };

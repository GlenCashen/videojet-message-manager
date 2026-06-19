import { getDb } from '../db.js';

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(value);
}

function targetFromRow(row) {
  return {
    jobId: row.job_id,
    printerId: row.printer_id,
    printerName: row.printer_name,
    printerMessageName: row.printer_message_name,
    preview: parseJson(row.preview_json, {}),
    status: row.status,
    result: parseJson(row.result_json, null),
    actedByUserId: row.acted_by_user_id || null,
    actedByUsername: row.acted_by_username || null,
    actedAt: row.acted_at || null,
    updatedAt: row.updated_at
  };
}

function jobFromRow(row, db) {
  if (!row) return null;
  const targets = db.prepare('SELECT * FROM message_job_targets WHERE job_id = ? ORDER BY rowid').all(row.id).map(targetFromRow);
  return {
    id: row.id,
    messageId: row.message_id,
    displayName: row.display_name,
    fields: parseJson(row.fields_json, {}),
    productionDate: row.production_date || null,
    status: row.status,
    createdByUserId: row.created_by_user_id || null,
    createdByUsername: row.created_by_username || null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    targets
  };
}

function expireJobs(db = getDb()) {
  const now = new Date().toISOString();
  const ids = db.prepare(`
    SELECT id FROM message_jobs
    WHERE expires_at <= ? AND status IN ('pending', 'in_progress')
  `).all(now).map((row) => row.id);
  if (!ids.length) return;
  const run = db.transaction(() => {
    const expireTargets = db.prepare("UPDATE message_job_targets SET status = 'expired', updated_at = ? WHERE job_id = ? AND status = 'pending'");
    const expireJob = db.prepare("UPDATE message_jobs SET status = 'expired', updated_at = ? WHERE id = ?");
    for (const id of ids) {
      expireTargets.run(now, id);
      expireJob.run(now, id);
    }
  });
  run();
}

function getMessageJob(id, db = getDb()) {
  expireJobs(db);
  return jobFromRow(db.prepare('SELECT * FROM message_jobs WHERE id = ?').get(id), db);
}

function listMessageJobs({ limit = 100 } = {}, db = getDb()) {
  expireJobs(db);
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db.prepare('SELECT * FROM message_jobs ORDER BY created_at DESC LIMIT ?').all(safeLimit)
    .map((row) => jobFromRow(row, db));
}

function createMessageJob(job, db = getDb()) {
  const now = job.createdAt || new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO message_jobs (
        id, message_id, display_name, fields_json, production_date, status,
        created_by_user_id, created_by_username, expires_at, created_at, updated_at
      ) VALUES (
        @id, @messageId, @displayName, @fieldsJson, @productionDate, 'pending',
        @createdByUserId, @createdByUsername, @expiresAt, @now, @now
      )
    `).run({
      id: job.id,
      messageId: job.messageId,
      displayName: job.displayName,
      fieldsJson: JSON.stringify(job.fields || {}),
      productionDate: job.productionDate || null,
      createdByUserId: job.createdByUserId || null,
      createdByUsername: job.createdByUsername || null,
      expiresAt: job.expiresAt,
      now
    });
    const insertTarget = db.prepare(`
      INSERT INTO message_job_targets (
        job_id, printer_id, printer_name, printer_message_name, preview_json, status, updated_at
      ) VALUES (@jobId, @printerId, @printerName, @printerMessageName, @previewJson, 'pending', @now)
    `);
    for (const target of job.targets) {
      insertTarget.run({
        jobId: job.id,
        printerId: target.printerId,
        printerName: target.printerName,
        printerMessageName: target.printerMessageName,
        previewJson: JSON.stringify(target.preview),
        now
      });
    }
  });
  run();
  return getMessageJob(job.id, db);
}

function aggregateStatus(targets) {
  const statuses = targets.map((target) => target.status);
  if (statuses.includes('processing')) return 'in_progress';
  if (statuses.includes('pending')) return statuses.some((status) => status !== 'pending') ? 'in_progress' : 'pending';
  if (statuses.every((status) => status === 'expired')) return 'expired';
  if (statuses.every((status) => status === 'declined' || status === 'expired')) return 'declined';
  if (statuses.every((status) => status === 'succeeded' || status === 'declined')) return 'completed';
  if (statuses.every((status) => status === 'failed')) return 'failed';
  return statuses.includes('failed') ? 'partial' : 'completed';
}

function updateMessageJobTarget(jobId, printerId, changes, actor = {}, db = getDb()) {
  const run = db.transaction(() => {
    const current = db.prepare('SELECT * FROM message_job_targets WHERE job_id = ? AND printer_id = ?').get(jobId, printerId);
    if (!current) throw new Error(`Printer ${printerId} is not a target of message job ${jobId}.`);
    const now = new Date().toISOString();
    const actorUserId = actor.developmentIdentity ? null : actor.id;
    db.prepare(`
      UPDATE message_job_targets SET
        status = @status,
        result_json = @resultJson,
        acted_by_user_id = @actedByUserId,
        acted_by_username = @actedByUsername,
        acted_at = @actedAt,
        updated_at = @now
      WHERE job_id = @jobId AND printer_id = @printerId
    `).run({
      jobId,
      printerId,
      status: changes.status || current.status,
      resultJson: changes.result === undefined ? current.result_json : JSON.stringify(changes.result),
      actedByUserId: actorUserId || current.acted_by_user_id || null,
      actedByUsername: actor.username || current.acted_by_username || null,
      actedAt: actor.id || actor.username ? now : current.acted_at,
      now
    });
    const targets = db.prepare('SELECT * FROM message_job_targets WHERE job_id = ?').all(jobId).map(targetFromRow);
    db.prepare('UPDATE message_jobs SET status = ?, updated_at = ? WHERE id = ?').run(aggregateStatus(targets), now, jobId);
  });
  run();
  return getMessageJob(jobId, db);
}

export {
  createMessageJob,
  getMessageJob,
  listMessageJobs,
  updateMessageJobTarget
};

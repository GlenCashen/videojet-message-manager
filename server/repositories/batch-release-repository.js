import crypto from 'node:crypto';
import { getDb } from '../db.js';

function parseJson(value, fallback = null) {
  return value ? JSON.parse(value) : fallback;
}

function actorUserId(actor = {}) {
  return actor.developmentIdentity ? null : (actor.id || null);
}

function releaseFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    productMasterId: row.product_master_id,
    productMasterVersionId: row.product_master_version_id,
    productMasterVersion: row.product_master_version || null,
    status: row.status,
    brewSheetProduct: row.brew_sheet_product,
    brewNumber: row.brew_number || null,
    batchNumber: row.batch_number || null,
    plannedProductionAt: row.planned_production_at,
    printerIds: parseJson(row.printer_ids_json, []),
    notes: row.notes || null,
    runNumber: row.run_number,
    runCode: row.run_code || null,
    expectedOutput: parseJson(row.expected_output_json, null),
    createdByUserId: row.created_by_user_id || null,
    createdByUsername: row.created_by_username,
    submittedAt: row.submitted_at || null,
    reviewedByUserId: row.reviewed_by_user_id || null,
    reviewedByUsername: row.reviewed_by_username || null,
    reviewedAt: row.reviewed_at || null,
    rejectionReason: row.rejection_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getBatchRelease(id, db = getDb()) {
  return releaseFromRow(db.prepare(`
    SELECT br.*, pmv.version AS product_master_version
    FROM batch_releases br
    JOIN product_master_versions pmv ON pmv.id = br.product_master_version_id
    WHERE br.id = ?
  `).get(id));
}

function listBatchReleases({ limit = 100, statuses = [] } = {}, db = getDb()) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const normalized = statuses.filter(Boolean);
  if (!normalized.length) return db.prepare(`
    SELECT br.*, pmv.version AS product_master_version
    FROM batch_releases br JOIN product_master_versions pmv ON pmv.id = br.product_master_version_id
    ORDER BY br.created_at DESC LIMIT ?
  `).all(safeLimit).map(releaseFromRow);
  const placeholders = normalized.map(() => '?').join(',');
  return db.prepare(`
    SELECT br.*, pmv.version AS product_master_version
    FROM batch_releases br JOIN product_master_versions pmv ON pmv.id = br.product_master_version_id
    WHERE br.status IN (${placeholders}) ORDER BY br.created_at DESC LIMIT ?
  `)
    .all(...normalized, safeLimit).map(releaseFromRow);
}

function createBatchRelease(input, actor, db = getDb()) {
  const master = db.prepare('SELECT * FROM product_masters WHERE id = ? AND enabled = 1').get(input.productMasterId);
  if (!master) throw new Error('Select an enabled product master.');
  const version = db.prepare('SELECT * FROM product_master_versions WHERE product_master_id = ? AND version = ?')
    .get(master.id, master.current_version);
  const specification = JSON.parse(version.specification_json);
  const brewSheetProduct = String(input.brewSheetProduct || '').trim().toUpperCase();
  const planned = new Date(input.plannedProductionAt);
  const printerIds = [...new Set((Array.isArray(input.printerIds) ? input.printerIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!brewSheetProduct || brewSheetProduct.length > 50) throw new Error('Brew-sheet product is required and must be at most 50 characters.');
  if (Number.isNaN(planned.valueOf())) throw new Error('A valid planned production date and time is required.');
  if (!printerIds.length) throw new Error('Select at least one target printer.');
  if (printerIds.some((id) => !specification.printerIds.includes(id))) throw new Error('One or more printers are not permitted by this product master.');
  const now = new Date().toISOString();
  const release = {
    id: crypto.randomUUID(),
    productMasterId: master.id,
    versionId: version.id,
    brewSheetProduct,
    brewNumber: String(input.brewNumber || '').trim().toUpperCase() || null,
    batchNumber: String(input.batchNumber || '').trim().toUpperCase() || null,
    plannedProductionAt: planned.toISOString(),
    printerIds,
    notes: String(input.notes || '').trim().slice(0, 1000) || null,
    userId: actorUserId(actor),
    username: actor.username,
    now
  };
  db.prepare(`
    INSERT INTO batch_releases (
      id, product_master_id, product_master_version_id, status, brew_sheet_product,
      brew_number, batch_number, planned_production_at, printer_ids_json, notes,
      created_by_user_id, created_by_username, created_at, updated_at
    ) VALUES (
      @id, @productMasterId, @versionId, 'draft', @brewSheetProduct,
      @brewNumber, @batchNumber, @plannedProductionAt, @printerIdsJson, @notes,
      @userId, @username, @now, @now
    )
  `).run({ ...release, printerIdsJson: JSON.stringify(printerIds) });
  return getBatchRelease(release.id, db);
}

function submitBatchRelease(id, actor, db = getDb()) {
  const release = getBatchRelease(id, db);
  if (!release) return null;
  if (!['draft', 'rejected'].includes(release.status)) throw new Error('Only draft or rejected releases can be submitted.');
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE batch_releases SET status = 'pending_review', submitted_at = ?, rejection_reason = NULL,
      reviewed_by_user_id = NULL, reviewed_by_username = NULL, reviewed_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, now, id);
  return getBatchRelease(id, db);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function addMonthsClamped(date, months) {
  const result = new Date(date.valueOf());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function renderTemplate(template, values) {
  return template.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key) => values[key] ?? '');
}

function approveBatchRelease(id, actor, db = getDb()) {
  return db.transaction(() => {
    const release = getBatchRelease(id, db);
    if (!release) return null;
    if (release.status !== 'pending_review') throw new Error('Only releases pending review can be approved.');
    const sameUser = release.createdByUserId && actorUserId(actor)
      ? release.createdByUserId === actorUserId(actor)
      : release.createdByUsername.toLowerCase() === String(actor.username || '').toLowerCase();
    if (sameUser) {
      const error = new Error('A different person must review and approve this release.');
      error.statusCode = 409;
      throw error;
    }
    const master = db.prepare('SELECT * FROM product_masters WHERE id = ?').get(release.productMasterId);
    const version = db.prepare('SELECT * FROM product_master_versions WHERE id = ?').get(release.productMasterVersionId);
    const specification = JSON.parse(version.specification_json);
    const runNumber = master.next_run_number;
    const digits = String(runNumber).padStart(specification.runWidth, '0');
    if (digits.length > specification.runWidth) throw new Error(`Run sequence for ${master.product_code} exceeds its configured width.`);
    const runCode = `${specification.runPrefix}${digits}`;
    const production = new Date(release.plannedProductionAt);
    const bestBefore = addMonthsClamped(production, specification.bestBeforeMonths);
    const values = {
      run: runCode,
      batch: release.brewSheetProduct,
      bestBeforeDate: `${pad2(bestBefore.getUTCDate())}/${pad2(bestBefore.getUTCMonth() + 1)}/${bestBefore.getUTCFullYear()}`,
      productionTime: `${pad2(production.getUTCHours())}:${pad2(production.getUTCMinutes())}:${pad2(production.getUTCSeconds())}`
    };
    values.currentTime = values.productionTime;
    const sourceValues = {
      run_code: runCode,
      brew_sheet_product: release.brewSheetProduct,
      brew_number: release.brewNumber || '',
      batch_number: release.batchNumber || ''
    };
    const fieldMappings = specification.fieldMappings || [
      { fieldKey: specification.runFieldKey, source: 'run_code' },
      { fieldKey: specification.batchFieldKey, source: 'brew_sheet_product' }
    ];
    const fields = Object.fromEntries(fieldMappings.map((mapping) => [mapping.fieldKey, sourceValues[mapping.source] ?? '']));
    Object.assign(values, fields);
    const expectedOutput = {
      messageId: specification.messageId,
      fields,
      lines: [
        renderTemplate(specification.firstLineTemplate, values),
        renderTemplate(specification.secondLineTemplate, values)
      ],
      specification,
      productMasterVersionId: version.id
    };
    expectedOutput.rendered = expectedOutput.lines.join('\n');
    const now = new Date().toISOString();
    db.prepare('UPDATE product_masters SET next_run_number = ?, updated_at = ? WHERE id = ?')
      .run(runNumber + 1, now, master.id);
    db.prepare(`
      UPDATE batch_releases SET status = 'released', run_number = ?, run_code = ?, expected_output_json = ?,
        reviewed_by_user_id = ?, reviewed_by_username = ?, reviewed_at = ?, rejection_reason = NULL, updated_at = ?
      WHERE id = ?
    `).run(runNumber, runCode, JSON.stringify(expectedOutput), actorUserId(actor), actor.username, now, now, id);
    return getBatchRelease(id, db);
  })();
}

function rejectBatchRelease(id, reason, actor, db = getDb()) {
  const release = getBatchRelease(id, db);
  if (!release) return null;
  if (release.status !== 'pending_review') throw new Error('Only releases pending review can be rejected.');
  const value = String(reason || '').trim();
  if (!value) throw new Error('A rejection reason is required.');
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE batch_releases SET status = 'rejected', reviewed_by_user_id = ?, reviewed_by_username = ?,
      reviewed_at = ?, rejection_reason = ?, updated_at = ? WHERE id = ?
  `).run(actorUserId(actor), actor.username, now, value.slice(0, 500), now, id);
  return getBatchRelease(id, db);
}

export { approveBatchRelease, createBatchRelease, getBatchRelease, listBatchReleases, rejectBatchRelease, submitBatchRelease };

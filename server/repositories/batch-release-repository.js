import crypto from 'node:crypto';
import { getDb } from '../db.js';

function parseJson(value, fallback = null) {
  return value ? JSON.parse(value) : fallback;
}

function actorUserId(actor = {}) {
  return actor.developmentIdentity ? null : (actor.id || null);
}

function actorOwnerKey(actor = {}) {
  return actorUserId(actor) ? `user:${actorUserId(actor)}` : `username:${String(actor.username || '').toLowerCase()}`;
}

function releaseFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    productMasterId: row.product_master_id,
    productMasterVersionId: row.product_master_version_id,
    productMasterVersion: row.product_master_version || null,
    productMasterSpecification: parseJson(row.product_master_specification_json, null),
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
    reviewClaim: row.claim_expires_at && new Date(row.claim_expires_at).valueOf() > Date.now() ? {
      claimedByUserId: row.claimed_by_user_id || null,
      claimedByUsername: row.claimed_by_username,
      claimedAt: row.claimed_at,
      expiresAt: row.claim_expires_at
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function executionTargetFromRow(row) {
  const status = row.status === 'completed' && row.running_at && !row.ended_at ? 'running' : row.status;
  return {
    printerId: row.printer_id,
    status,
    appliedByUserId: row.applied_by_user_id || null,
    appliedByUsername: row.applied_by_username || null,
    appliedAt: row.applied_at || null,
    verifiedByUserId: row.verified_by_user_id || null,
    verifiedByUsername: row.verified_by_username || null,
    verifiedAt: row.verified_at || null,
    runningAt: row.running_at || null,
    endedAt: row.ended_at || null,
    error: row.error_message || null,
    result: parseJson(row.result_json, null),
    updatedAt: row.updated_at
  };
}

function attachExecutionTargets(release, db) {
  if (!release) return null;
  const executionTargets = db.prepare(`
    SELECT * FROM batch_release_execution_targets WHERE release_id = ? ORDER BY printer_id
  `).all(release.id).map(executionTargetFromRow);
  return {
    ...release,
    status: executionTargets.some((target) => target.status === 'running') ? 'running' : release.status,
    executionTargets
  };
}

function getBatchRelease(id, db = getDb()) {
  return attachExecutionTargets(releaseFromRow(db.prepare(`
    SELECT br.*, pmv.version AS product_master_version, pmv.specification_json AS product_master_specification_json,
      rc.claimed_by_user_id, rc.claimed_by_username, rc.claimed_at, rc.expires_at AS claim_expires_at
    FROM batch_releases br
    JOIN product_master_versions pmv ON pmv.id = br.product_master_version_id
    LEFT JOIN release_review_claims rc ON rc.release_id = br.id
    WHERE br.id = ?
  `).get(id)), db);
}

function listBatchReleases({ limit = 100, statuses = [] } = {}, db = getDb()) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const normalized = statuses.filter(Boolean);
  if (!normalized.length) return db.prepare(`
    SELECT br.*, pmv.version AS product_master_version, pmv.specification_json AS product_master_specification_json,
      rc.claimed_by_user_id, rc.claimed_by_username, rc.claimed_at, rc.expires_at AS claim_expires_at
    FROM batch_releases br JOIN product_master_versions pmv ON pmv.id = br.product_master_version_id
    LEFT JOIN release_review_claims rc ON rc.release_id = br.id
    ORDER BY br.created_at DESC LIMIT ?
  `).all(safeLimit).map(releaseFromRow).map((release) => attachExecutionTargets(release, db));
  const placeholders = normalized.map(() => '?').join(',');
  return db.prepare(`
    SELECT br.*, pmv.version AS product_master_version, pmv.specification_json AS product_master_specification_json,
      rc.claimed_by_user_id, rc.claimed_by_username, rc.claimed_at, rc.expires_at AS claim_expires_at
    FROM batch_releases br JOIN product_master_versions pmv ON pmv.id = br.product_master_version_id
    LEFT JOIN release_review_claims rc ON rc.release_id = br.id
    WHERE br.status IN (${placeholders}) ORDER BY br.created_at DESC LIMIT ?
  `)
    .all(...normalized, safeLimit).map(releaseFromRow).map((release) => attachExecutionTargets(release, db));
}

function listBatchReleasesPage({ limit = 25, offset = 0, statuses = [], search = '', printerIds = [] } = {}, db = getDb()) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const normalized = statuses.filter(Boolean);
  const query = String(search || '').trim().toLowerCase().slice(0, 100);
  const where = [];
  const params = [];
  if (normalized.length) {
    where.push(`br.status IN (${normalized.map(() => '?').join(',')})`);
    params.push(...normalized);
  }
  if (query) {
    where.push(`LOWER(COALESCE(pm.product_code, '') || ' ' || COALESCE(pm.display_name, '') || ' ' ||
      COALESCE(br.brew_sheet_product, '') || ' ' || COALESCE(br.brew_number, '') || ' ' ||
      COALESCE(br.batch_number, '') || ' ' || COALESCE(br.run_code, '') || ' ' || COALESCE(br.created_by_username, '')) LIKE ?`);
    params.push(`%${query}%`);
  }
  if (printerIds.length) {
    where.push(`EXISTS (SELECT 1 FROM json_each(br.printer_ids_json) assigned WHERE assigned.value IN (${printerIds.map(() => '?').join(',')}))`);
    params.push(...printerIds);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const fromSql = `FROM batch_releases br
    JOIN product_master_versions pmv ON pmv.id = br.product_master_version_id
    JOIN product_masters pm ON pm.id = br.product_master_id
    LEFT JOIN release_review_claims rc ON rc.release_id = br.id`;
  const total = db.prepare(`SELECT COUNT(*) AS count ${fromSql} ${whereSql}`).get(...params).count;
  const items = db.prepare(`
    SELECT br.*, pmv.version AS product_master_version, pmv.specification_json AS product_master_specification_json,
      rc.claimed_by_user_id, rc.claimed_by_username, rc.claimed_at, rc.expires_at AS claim_expires_at
    ${fromSql} ${whereSql}
    ORDER BY br.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, safeLimit, safeOffset).map(releaseFromRow).map((release) => attachExecutionTargets(release, db));
  const countScope = printerIds.length
    ? `WHERE EXISTS (SELECT 1 FROM json_each(printer_ids_json) assigned WHERE assigned.value IN (${printerIds.map(() => '?').join(',')}))`
    : '';
  const counts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS count FROM batch_releases ${countScope} GROUP BY status`)
    .all(...printerIds).map((row) => [row.status, row.count]));
  return { items, total, limit: safeLimit, offset: safeOffset, counts };
}

function refreshBatchReleaseExecutionStatus(id, db) {
  const statuses = db.prepare('SELECT status FROM batch_release_execution_targets WHERE release_id = ?').all(id).map((row) => row.status);
  let status = 'released';
  if (statuses.length && statuses.every((value) => value === 'completed')) status = 'completed';
  else if (statuses.includes('applying')) status = 'applying';
  else if (statuses.includes('awaiting_print_check')) status = 'awaiting_print_check';
  else if (statuses.includes('failed')) status = 'failed';
  db.prepare('UPDATE batch_releases SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}

function recoverInterruptedBatchReleaseTargets(db = getDb()) {
  return db.transaction(() => {
    const releaseIds = db.prepare(`
      SELECT DISTINCT release_id FROM batch_release_execution_targets WHERE status = 'applying'
    `).all().map((row) => row.release_id);
    if (!releaseIds.length) return 0;
    const now = new Date().toISOString();
    const warning = 'Server restarted during message application. Confirm the printer state before retrying.';
    db.prepare(`
      UPDATE batch_release_execution_targets SET status = 'failed', error_message = ?, updated_at = ?
      WHERE status = 'applying'
    `).run(warning, now);
    for (const releaseId of releaseIds) refreshBatchReleaseExecutionStatus(releaseId, db);
    return releaseIds.length;
  })();
}

function beginBatchReleaseTarget(id, printerId, actor, { reapply = false, reason = '' } = {}, db = getDb()) {
  return db.transaction(() => {
    const release = getBatchRelease(id, db);
    if (!release) return null;
    if (!['released', 'applying', 'awaiting_print_check', 'running', 'completed', 'failed'].includes(release.status)) {
      throw new Error('This release is not available for operator execution.');
    }
    const target = release.executionTargets.find((item) => item.printerId === printerId);
    if (!target) throw new Error('This printer is not an execution target for the release.');
    const isReapply = reapply === true && target.status === 'completed';
    if (!['pending', 'failed'].includes(target.status) && !isReapply) throw new Error('This printer target is already in progress or awaiting verification.');
    if (target.status === 'failed' && !String(reason || '').trim()) {
      throw new Error('Confirm the physical printer state and enter a reason before retrying an uncertain send.');
    }
    if (isReapply && !String(reason || '').trim()) throw new Error('Enter a reason for reapplying a completed release.');
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE batch_release_execution_targets SET status = 'applying', applied_by_user_id = ?, applied_by_username = ?,
        applied_at = ?, verified_by_user_id = NULL, verified_by_username = NULL, verified_at = NULL,
        running_at = NULL, ended_at = NULL, error_message = NULL, result_json = NULL, updated_at = ? WHERE release_id = ? AND printer_id = ?
    `).run(actorUserId(actor), actor.username, now, now, id, printerId);
    refreshBatchReleaseExecutionStatus(id, db);
    return getBatchRelease(id, db);
  })();
}

function finishBatchReleaseTarget(id, printerId, result, db = getDb()) {
  const now = new Date().toISOString();
  const succeeded = result?.ok !== false && result?.messageMatches !== false;
  db.prepare(`
    UPDATE batch_release_execution_targets SET status = ?, error_message = ?, result_json = ?, updated_at = ?
    WHERE release_id = ? AND printer_id = ?
  `).run(succeeded ? 'awaiting_print_check' : 'failed', succeeded ? null : String(result?.error || 'Printer verification failed').slice(0, 500), JSON.stringify(result || {}), now, id, printerId);
  refreshBatchReleaseExecutionStatus(id, db);
  return getBatchRelease(id, db);
}

function verifyBatchReleaseTarget(id, printerId, { passed, reason } = {}, actor, db = getDb()) {
  return db.transaction(() => {
    const release = getBatchRelease(id, db);
    if (!release) return null;
    const target = release.executionTargets.find((item) => item.printerId === printerId);
    if (!target) throw new Error('This printer is not an execution target for the release.');
    if (target.status !== 'awaiting_print_check') throw new Error('This target is not awaiting a first-print check.');
    const failureReason = String(reason || '').trim();
    if (passed !== true && !failureReason) throw new Error('Enter a reason when the first-print check fails.');
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE batch_release_execution_targets SET status = ?, verified_by_user_id = ?, verified_by_username = ?,
        verified_at = ?, running_at = ?, ended_at = NULL, error_message = ?, updated_at = ? WHERE release_id = ? AND printer_id = ?
    `).run(passed === true ? 'completed' : 'failed', actorUserId(actor), actor.username, now, passed === true ? now : null, passed === true ? null : failureReason.slice(0, 500), now, id, printerId);
    refreshBatchReleaseExecutionStatus(id, db);
    return getBatchRelease(id, db);
  })();
}

function endBatchReleaseTargetRun(id, printerId, actor, db = getDb()) {
  return db.transaction(() => {
    const release = getBatchRelease(id, db);
    if (!release) return null;
    const target = release.executionTargets.find((item) => item.printerId === printerId);
    if (!target) throw new Error('This printer is not an execution target for the release.');
    if (target.status !== 'running') throw new Error('This production target is not currently running.');
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE batch_release_execution_targets SET ended_at = ?, updated_at = ? WHERE release_id = ? AND printer_id = ?
    `).run(now, now, id, printerId);
    refreshBatchReleaseExecutionStatus(id, db);
    return getBatchRelease(id, db);
  })();
}

function endOtherRunningTargets(printerId, exceptReleaseId, db = getDb()) {
  return db.transaction(() => {
    const releaseIds = db.prepare(`
      SELECT release_id FROM batch_release_execution_targets
      WHERE printer_id = ? AND release_id <> ? AND status = 'completed' AND running_at IS NOT NULL AND ended_at IS NULL
    `).all(printerId, exceptReleaseId).map((row) => row.release_id);
    if (!releaseIds.length) return [];
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE batch_release_execution_targets SET ended_at = ?, updated_at = ?
      WHERE printer_id = ? AND release_id <> ? AND status = 'completed' AND running_at IS NOT NULL AND ended_at IS NULL
    `).run(now, now, printerId, exceptReleaseId);
    for (const releaseId of releaseIds) refreshBatchReleaseExecutionStatus(releaseId, db);
    return releaseIds;
  })();
}

function claimBatchReleaseReview(id, actor, ttlMs = 45000, db = getDb()) {
  const release = getBatchRelease(id, db);
  if (!release) return null;
  if (release.status !== 'pending_review') throw new Error('Only releases pending review can be claimed.');
  const now = new Date();
  const values = {
    releaseId: id,
    ownerKey: actorOwnerKey(actor),
    userId: actorUserId(actor),
    username: actor.username,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.valueOf() + ttlMs).toISOString(),
    now: now.toISOString()
  };
  const result = db.prepare(`
    INSERT INTO release_review_claims (
      release_id, owner_key, claimed_by_user_id, claimed_by_username, claimed_at, expires_at
    ) VALUES (@releaseId, @ownerKey, @userId, @username, @claimedAt, @expiresAt)
    ON CONFLICT(release_id) DO UPDATE SET
      owner_key = excluded.owner_key,
      claimed_by_user_id = excluded.claimed_by_user_id,
      claimed_by_username = excluded.claimed_by_username,
      claimed_at = CASE WHEN release_review_claims.owner_key = excluded.owner_key THEN release_review_claims.claimed_at ELSE excluded.claimed_at END,
      expires_at = excluded.expires_at
    WHERE release_review_claims.expires_at <= @now OR release_review_claims.owner_key = excluded.owner_key
  `).run(values);
  if (!result.changes) {
    const claim = getBatchRelease(id, db)?.reviewClaim;
    const error = new Error(`${claim?.claimedByUsername || 'Another user'} is already reviewing this release.`);
    error.statusCode = 409;
    error.reviewClaim = claim;
    throw error;
  }
  return getBatchRelease(id, db);
}

function releaseBatchReleaseReview(id, actor, db = getDb()) {
  db.prepare('DELETE FROM release_review_claims WHERE release_id = ? AND owner_key = ?')
    .run(id, actorOwnerKey(actor));
  return getBatchRelease(id, db);
}

function assertReviewClaimAvailable(id, actor, db) {
  const claim = getBatchRelease(id, db)?.reviewClaim;
  if (!claim) return;
  const mine = claim.claimedByUserId && actorUserId(actor)
    ? claim.claimedByUserId === actorUserId(actor)
    : claim.claimedByUsername.toLowerCase() === String(actor.username || '').toLowerCase();
  if (!mine) {
    const error = new Error(`${claim.claimedByUsername} is already reviewing this release.`);
    error.statusCode = 409;
    throw error;
  }
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

function updateBatchRelease(id, input, actor, db = getDb()) {
  const release = getBatchRelease(id, db);
  if (!release) return null;
  if (!['draft', 'rejected'].includes(release.status)) {
    throw new Error('Approved releases are locked. Return the release for correction with a reason before editing it.');
  }
  const version = db.prepare('SELECT * FROM product_master_versions WHERE id = ?').get(release.productMasterVersionId);
  const specification = JSON.parse(version.specification_json);
  const brewSheetProduct = String(input.brewSheetProduct || '').trim().toUpperCase();
  const planned = new Date(input.plannedProductionAt);
  const printerIds = [...new Set((Array.isArray(input.printerIds) ? input.printerIds : [])
    .map((printerId) => String(printerId || '').trim()).filter(Boolean))];
  if (!brewSheetProduct || brewSheetProduct.length > 50) throw new Error('Brew-sheet product is required and must be at most 50 characters.');
  if (Number.isNaN(planned.valueOf())) throw new Error('A valid planned production date and time is required.');
  if (!printerIds.length) throw new Error('Select at least one target printer.');
  if (printerIds.some((printerId) => !specification.printerIds.includes(printerId))) {
    throw new Error('One or more printers are not permitted by this product master version.');
  }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE batch_releases SET status = 'draft', product_master_version_id = ?, brew_sheet_product = ?, brew_number = ?, batch_number = ?,
      planned_production_at = ?, printer_ids_json = ?, notes = ?, submitted_at = NULL,
      reviewed_by_user_id = NULL, reviewed_by_username = NULL, reviewed_at = NULL,
      rejection_reason = NULL, expected_output_json = NULL, updated_at = ? WHERE id = ?
  `).run(
    version.id,
    brewSheetProduct,
    String(input.brewNumber || '').trim().toUpperCase() || null,
    String(input.batchNumber || '').trim().toUpperCase() || null,
    planned.toISOString(),
    JSON.stringify(printerIds),
    String(input.notes || '').trim().slice(0, 1000) || null,
    now,
    id
  );
  return getBatchRelease(id, db);
}

function submitBatchRelease(id, actor, db = getDb()) {
  const release = getBatchRelease(id, db);
  if (!release) return null;
  if (release.status !== 'draft') throw new Error('A rejected release must be edited and saved as a draft before it can be submitted again.');
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

function formatReleaseDate(date, format = 'DD/MM/YYYY') {
  const values = {
    DD: pad2(date.getUTCDate()), MM: pad2(date.getUTCMonth() + 1),
    YYYY: String(date.getUTCFullYear()), YY: String(date.getUTCFullYear()).slice(-2)
  };
  return format.replace(/YYYY|YY|DD|MM/g, (token) => values[token]);
}

function formatReleaseTime(date, format = 'HH:mm:ss') {
  if (format === 'HH:mm') return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  if (format === 'hh:mm A') {
    const period = date.getUTCHours() >= 12 ? 'PM' : 'AM';
    return `${pad2(date.getUTCHours() % 12 || 12)}:${pad2(date.getUTCMinutes())} ${period}`;
  }
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
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

function printerConfigurations(specification) {
  if (Array.isArray(specification.printerConfigurations) && specification.printerConfigurations.length) {
    return specification.printerConfigurations;
  }
  return (specification.printerIds || []).map((printerId) => ({
    printerId,
    messageId: specification.messageId,
    fieldMappings: specification.fieldMappings,
    dateRule: specification.dateRule || { type: 'offset-months', months: specification.bestBeforeMonths, format: 'DD/MM/YYYY' },
    timeRule: specification.timeRule,
    previewLines: specification.previewLines || [specification.firstLineTemplate, specification.secondLineTemplate].filter(Boolean)
  }));
}

function expectedOutputForRelease(release, version, runNumber) {
  const specification = JSON.parse(version.specification_json);
  const digits = String(runNumber).padStart(specification.runWidth, '0');
  if (digits.length > specification.runWidth) throw new Error('The product run sequence exceeds its configured width.');
  const runCode = `${specification.runPrefix}${digits}`;
  const production = new Date(release.plannedProductionAt);
  const sourceValues = {
    run_code: runCode,
    brew_sheet_product: release.brewSheetProduct,
    brew_number: release.brewNumber || '',
    batch_number: release.batchNumber || ''
  };
  const byPrinter = {};
  for (const configuration of printerConfigurations(specification)) {
    const months = configuration.dateRule?.months ?? specification.bestBeforeMonths;
    const bestBefore = addMonthsClamped(production, months);
    const values = {
      run: runCode,
      batch: release.brewSheetProduct,
      bestBeforeDate: formatReleaseDate(bestBefore, configuration.dateRule?.format),
      productionTime: formatReleaseTime(production, configuration.timeRule?.format)
    };
    values.currentTime = values.productionTime;
    const fieldMappings = configuration.fieldMappings || [];
    const fields = Object.fromEntries(fieldMappings.map((mapping) => [mapping.fieldKey, sourceValues[mapping.source] ?? '']));
    Object.assign(values, fields);
    const lines = (configuration.previewLines || []).map((line) => renderTemplate(line, values));
    byPrinter[configuration.printerId] = {
      printerId: configuration.printerId,
      messageId: configuration.messageId,
      fields,
      lines,
      rendered: lines.join('\n')
    };
  }
  const firstOutput = byPrinter[release.printerIds[0]] || Object.values(byPrinter)[0];
  const expectedOutput = { ...firstOutput, byPrinter, specification, productMasterVersionId: version.id };
  return { runCode, expectedOutput };
}

function reserveBatchReleaseRun(id, db = getDb()) {
  return db.transaction(() => {
    const release = getBatchRelease(id, db);
    if (!release) return null;
    if (release.runNumber) return release;
    if (release.status !== 'released') throw new Error('Only an approved release can be prepared for production.');
    const master = db.prepare('SELECT * FROM product_masters WHERE id = ?').get(release.productMasterId);
    const version = db.prepare('SELECT * FROM product_master_versions WHERE id = ?').get(release.productMasterVersionId);
    const runNumber = master.next_run_number;
    const { runCode, expectedOutput } = expectedOutputForRelease(release, version, runNumber);
    const now = new Date().toISOString();
    db.prepare('UPDATE product_masters SET next_run_number = ?, updated_at = ? WHERE id = ?').run(runNumber + 1, now, master.id);
    db.prepare(`
      UPDATE batch_releases SET run_number = ?, run_code = ?, expected_output_json = ?, updated_at = ? WHERE id = ?
    `).run(runNumber, runCode, JSON.stringify(expectedOutput), now, id);
    return getBatchRelease(id, db);
  })();
}

function approveBatchRelease(id, actor, db = getDb()) {
  return db.transaction(() => {
    const release = getBatchRelease(id, db);
    if (!release) return null;
    if (release.status !== 'pending_review') throw new Error('Only releases pending review can be approved.');
    assertReviewClaimAvailable(id, actor, db);
    const sameUser = release.createdByUserId && actorUserId(actor)
      ? release.createdByUserId === actorUserId(actor)
      : release.createdByUsername.toLowerCase() === String(actor.username || '').toLowerCase();
    if (sameUser) {
      const error = new Error('A different person must review and approve this release.');
      error.statusCode = 409;
      throw error;
    }
    const version = db.prepare('SELECT * FROM product_master_versions WHERE id = ?').get(release.productMasterVersionId);
    const prepared = release.runNumber ? expectedOutputForRelease(release, version, release.runNumber) : null;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE batch_releases SET status = 'released', run_number = ?, run_code = ?, expected_output_json = ?,
        reviewed_by_user_id = ?, reviewed_by_username = ?, reviewed_at = ?, rejection_reason = NULL, updated_at = ?
      WHERE id = ?
    `).run(release.runNumber || null, prepared?.runCode || null, prepared ? JSON.stringify(prepared.expectedOutput) : null, actorUserId(actor), actor.username, now, now, id);
    const insertTarget = db.prepare(`
      INSERT OR IGNORE INTO batch_release_execution_targets (release_id, printer_id, status, updated_at)
      VALUES (?, ?, 'pending', ?)
    `);
    for (const printerId of release.printerIds) insertTarget.run(id, printerId, now);
    db.prepare(`
      UPDATE batch_release_execution_targets SET status = 'pending', error_message = NULL, result_json = NULL,
        verified_by_user_id = NULL, verified_by_username = NULL, verified_at = NULL,
        running_at = NULL, ended_at = NULL, updated_at = ? WHERE release_id = ?
    `).run(now, id);
    db.prepare('DELETE FROM release_review_claims WHERE release_id = ?').run(id);
    return getBatchRelease(id, db);
  })();
}

function returnBatchReleaseForReview(id, reason, actor, db = getDb()) {
  return db.transaction(() => {
    const release = getBatchRelease(id, db);
    if (!release) return null;
    if (!['released', 'failed', 'awaiting_print_check'].includes(release.status)) {
      throw new Error('This release cannot be returned for correction in its current state.');
    }
    if (release.executionTargets.some((target) => target.status === 'completed')) {
      throw new Error('A partially completed release cannot be edited. Create a new release for the remaining work.');
    }
    const value = String(reason || '').trim();
    if (!value) throw new Error('A reason is required when returning a release for correction.');
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE batch_releases SET status = 'rejected', rejection_reason = ?, updated_at = ? WHERE id = ?
    `).run(value.slice(0, 500), now, id);
    return getBatchRelease(id, db);
  })();
}

function rejectBatchRelease(id, reason, actor, db = getDb()) {
  const release = getBatchRelease(id, db);
  if (!release) return null;
  if (release.status !== 'pending_review') throw new Error('Only releases pending review can be rejected.');
  assertReviewClaimAvailable(id, actor, db);
  const value = String(reason || '').trim();
  if (!value) throw new Error('A rejection reason is required.');
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE batch_releases SET status = 'rejected', reviewed_by_user_id = ?, reviewed_by_username = ?,
      reviewed_at = ?, rejection_reason = ?, updated_at = ? WHERE id = ?
  `).run(actorUserId(actor), actor.username, now, value.slice(0, 500), now, id);
  db.prepare('DELETE FROM release_review_claims WHERE release_id = ?').run(id);
  return getBatchRelease(id, db);
}

export {
  approveBatchRelease, beginBatchReleaseTarget, claimBatchReleaseReview, createBatchRelease,
  endBatchReleaseTargetRun, endOtherRunningTargets, finishBatchReleaseTarget, getBatchRelease, listBatchReleases, rejectBatchRelease,
  listBatchReleasesPage, recoverInterruptedBatchReleaseTargets, releaseBatchReleaseReview, reserveBatchReleaseRun,
  returnBatchReleaseForReview, submitBatchRelease, updateBatchRelease, verifyBatchReleaseTarget
};

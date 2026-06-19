import assert from 'node:assert/strict';
import test from 'node:test';

const { openDatabase, runMigrations } = await import('../server/db.js');
const { createProductMaster, updateProductMaster } = await import('../server/repositories/product-master-repository.js');
const {
  approveBatchRelease,
  beginBatchReleaseTarget,
  claimBatchReleaseReview,
  createBatchRelease,
  finishBatchReleaseTarget,
  getBatchRelease,
  rejectBatchRelease,
  recoverInterruptedBatchReleaseTargets,
  submitBatchRelease,
  updateBatchRelease,
  verifyBatchReleaseTarget
} = await import('../server/repositories/batch-release-repository.js');

function actor(username, role) {
  return { id: `dev-${username}`, username, roles: [role], developmentIdentity: true };
}

function masterInput(productCode, nextRunNumber) {
  return {
    productCode,
    displayName: productCode,
    nextRunNumber,
    specification: {
      runPrefix: 'T',
      runWidth: 4,
      bestBeforeMonths: 15,
      messageId: `${productCode.toLowerCase()}-message`,
      runFieldKey: 'run',
      batchFieldKey: 'batch',
      printerIds: ['coder-1']
    }
  };
}

function releaseInput(productMasterId, brewSheetProduct) {
  return {
    productMasterId,
    brewSheetProduct,
    brewNumber: 'H0477',
    batchNumber: 'FV27',
    plannedProductionAt: '2026-06-18T04:32:08.000Z',
    printerIds: ['coder-1']
  };
}

test('approval independently reserves product-scoped runs and pins the master version', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const qa = actor('qa-reviewer', 'qa');
  const planner = actor('planner-one', 'planner');
  const tbundrc = createProductMaster(masterInput('TBUNDRC', 50), qa, db);
  const smgold = createProductMaster(masterInput('SMGOLD', 20), qa, db);

  const firstDraft = createBatchRelease(releaseInput(tbundrc.id, 'TBUNDRC-50'), planner, db);
  updateProductMaster(tbundrc.id, {
    displayName: 'Bundaberg Rum and Cola',
    specification: { ...tbundrc.specification, bestBeforeMonths: 18 }
  }, qa, db);
  submitBatchRelease(firstDraft.id, planner, db);
  const firstApproved = approveBatchRelease(firstDraft.id, qa, db);
  assert.equal(firstApproved.runNumber, 50);
  assert.equal(firstApproved.runCode, 'T0050');
  assert.equal(firstApproved.expectedOutput.rendered, 'T0050TBUNDRC-50\nBBD: 18/09/2027 04:32:08');
  assert.equal(firstApproved.expectedOutput.specification.bestBeforeMonths, 15);

  const secondDraft = createBatchRelease(releaseInput(tbundrc.id, 'TBUNDRC-50'), planner, db);
  submitBatchRelease(secondDraft.id, planner, db);
  assert.equal(approveBatchRelease(secondDraft.id, qa, db).runNumber, 51);

  const otherDraft = createBatchRelease(releaseInput(smgold.id, 'SMGOLD-30'), planner, db);
  submitBatchRelease(otherDraft.id, planner, db);
  assert.equal(approveBatchRelease(otherDraft.id, qa, db).runNumber, 20);
  db.close();
});

test('creator cannot approve their own release and failed approval consumes no run', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const creator = actor('pack-lead-one', 'packaging_leader');
  const reviewer = actor('qa-two', 'qa');
  const master = createProductMaster(masterInput('TBUNDRC', 75), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'TBUNDRC-50'), creator, db);
  submitBatchRelease(draft.id, creator, db);
  assert.throws(() => approveBatchRelease(draft.id, creator, db), /different person/i);
  assert.equal(db.prepare('SELECT next_run_number FROM product_masters WHERE id = ?').get(master.id).next_run_number, 75);
  assert.equal(approveBatchRelease(draft.id, reviewer, db).runNumber, 75);
  db.close();
});

test('products with no message fields still reserve an audited product run', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-no-fields', 'planner');
  const reviewer = actor('qa-no-fields', 'qa');
  const master = createProductMaster({
    productCode: 'PLAIN',
    displayName: 'Message without user fields',
    nextRunNumber: 12,
    specification: {
      runPrefix: 'R',
      runWidth: 4,
      bestBeforeMonths: 12,
      messageId: 'plain-message',
      fieldMappings: [],
      printerIds: ['coder-1'],
      firstLineTemplate: 'STATIC PRODUCT CODE',
      secondLineTemplate: 'BBD: {{bestBeforeDate}} {{productionTime}}'
    }
  }, reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'PLAIN-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  const approved = approveBatchRelease(draft.id, reviewer, db);

  assert.equal(approved.runNumber, 12);
  assert.equal(approved.runCode, 'R0012');
  assert.deepEqual(approved.expectedOutput.fields, {});
  assert.equal(approved.expectedOutput.rendered, 'STATIC PRODUCT CODE\nBBD: 18/06/2027 04:32:08');
  assert.equal(db.prepare('SELECT next_run_number FROM product_masters WHERE id = ?').get(master.id).next_run_number, 13);
  db.close();
});

test('a rejected release must be corrected as a draft before resubmission', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-edit', 'planner');
  const reviewer = actor('qa-edit', 'qa');
  const master = createProductMaster(masterInput('TBUNDRC', 90), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'TBUNDRC-50'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  const rejected = rejectBatchRelease(draft.id, 'Incorrect brew number', reviewer, db);

  assert.equal(rejected.status, 'rejected');
  assert.throws(() => submitBatchRelease(draft.id, planner, db), /must be edited/i);
  const corrected = updateBatchRelease(draft.id, {
    ...releaseInput(master.id, 'TBUNDRC-51'),
    brewNumber: 'H0478',
    notes: 'Corrected against brew sheet'
  }, planner, db);
  assert.equal(corrected.status, 'draft');
  assert.equal(corrected.brewNumber, 'H0478');
  assert.equal(corrected.rejectionReason, null);
  assert.equal(corrected.productMasterVersionId, draft.productMasterVersionId);
  assert.equal(submitBatchRelease(draft.id, planner, db).status, 'pending_review');
  db.close();
});

test('an active review claim prevents a second reviewer from acting', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-claim', 'planner');
  const firstReviewer = actor('qa-claim-one', 'qa');
  const secondReviewer = actor('qa-claim-two', 'qa');
  const master = createProductMaster(masterInput('CLAIMED', 1), firstReviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'CLAIMED-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);

  const claimed = claimBatchReleaseReview(draft.id, firstReviewer, 45000, db);
  assert.equal(claimed.reviewClaim.claimedByUsername, firstReviewer.username);
  assert.throws(() => claimBatchReleaseReview(draft.id, secondReviewer, 45000, db), /already reviewing/i);
  assert.throws(() => approveBatchRelease(draft.id, secondReviewer, db), /already reviewing/i);
  assert.equal(approveBatchRelease(draft.id, firstReviewer, db).status, 'released');
  db.close();
});

test('approved printer targets move through send and first-print verification', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-execution', 'planner');
  const reviewer = actor('qa-execution', 'qa');
  const operator = actor('operator-execution', 'operator');
  const master = createProductMaster(masterInput('EXECUTE', 7), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'EXECUTE-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  const approved = approveBatchRelease(draft.id, reviewer, db);
  assert.equal(approved.executionTargets[0].status, 'pending');

  const applying = beginBatchReleaseTarget(draft.id, 'coder-1', operator, db);
  assert.equal(applying.status, 'applying');
  assert.equal(applying.executionTargets[0].appliedByUsername, operator.username);
  const awaiting = finishBatchReleaseTarget(draft.id, 'coder-1', { ok: true, messageMatches: true }, db);
  assert.equal(awaiting.status, 'awaiting_print_check');
  const completed = verifyBatchReleaseTarget(draft.id, 'coder-1', { passed: true }, operator, db);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.executionTargets[0].verifiedByUsername, operator.username);
  db.close();
});

test('startup recovery turns interrupted sends into operator attention', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-recovery', 'planner');
  const reviewer = actor('qa-recovery', 'qa');
  const operator = actor('operator-recovery', 'operator');
  const master = createProductMaster(masterInput('RECOVER', 3), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'RECOVER-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  beginBatchReleaseTarget(draft.id, 'coder-1', operator, db);

  assert.equal(recoverInterruptedBatchReleaseTargets(db), 1);
  const recovered = getBatchRelease(draft.id, db);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.executionTargets[0].status, 'failed');
  assert.match(recovered.executionTargets[0].error, /confirm the printer state/i);
  db.close();
});

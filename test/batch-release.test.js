import assert from 'node:assert/strict';
import test from 'node:test';

const { openDatabase, runMigrations } = await import('../server/db.js');
const { createProductMaster, updateProductMaster } = await import('../server/repositories/product-master-repository.js');
const {
  approveBatchRelease,
  beginBatchReleaseTarget,
  claimBatchReleaseReview,
  createBatchRelease,
  endBatchReleaseTargetRun,
  endOtherRunningTargets,
  finishBatchReleaseTarget,
  getBatchRelease,
  rejectBatchRelease,
  recoverInterruptedBatchReleaseTargets,
  reserveBatchReleaseRun,
  returnBatchReleaseForReview,
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
      printerConfigurations: [{
        printerId: 'coder-1',
        messageId: `${productCode.toLowerCase()}-message`,
        fieldMappings: [
          { fieldKey: 'run', source: 'run_code' },
          { fieldKey: 'batch', source: 'brew_sheet_product' }
        ],
        dateRule: { type: 'offset-months', months: 15, format: 'DD/MM/YYYY' },
        timeRule: { type: 'production-time', format: 'HH:mm:ss' },
        previewLines: ['{{run}}{{batch}}', 'BBD: {{bestBeforeDate}} {{productionTime}}']
      }]
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

test('first send independently reserves product-scoped runs and pins the master version', () => {
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
  const approval = approveBatchRelease(firstDraft.id, qa, db);
  assert.equal(approval.runNumber, null);
  assert.equal(db.prepare('SELECT next_run_number FROM product_masters WHERE id = ?').get(tbundrc.id).next_run_number, 50);
  const firstApproved = reserveBatchReleaseRun(firstDraft.id, db);
  assert.equal(firstApproved.runNumber, 50);
  assert.equal(firstApproved.runCode, 'T0050');
  assert.equal(firstApproved.expectedOutput.rendered, 'T0050TBUNDRC-50\nBBD: 18/09/2027 04:32:08');
  assert.equal(firstApproved.expectedOutput.specification.bestBeforeMonths, 15);

  const secondDraft = createBatchRelease(releaseInput(tbundrc.id, 'TBUNDRC-50'), planner, db);
  submitBatchRelease(secondDraft.id, planner, db);
  approveBatchRelease(secondDraft.id, qa, db);
  assert.equal(reserveBatchReleaseRun(secondDraft.id, db).runNumber, 51);

  const otherDraft = createBatchRelease(releaseInput(smgold.id, 'SMGOLD-30'), planner, db);
  submitBatchRelease(otherDraft.id, planner, db);
  approveBatchRelease(otherDraft.id, qa, db);
  assert.equal(reserveBatchReleaseRun(otherDraft.id, db).runNumber, 20);
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
  assert.equal(approveBatchRelease(draft.id, reviewer, db).runNumber, null);
  assert.equal(reserveBatchReleaseRun(draft.id, db).runNumber, 75);
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
  approveBatchRelease(draft.id, reviewer, db);
  const approved = reserveBatchReleaseRun(draft.id, db);

  assert.equal(approved.runNumber, 12);
  assert.equal(approved.runCode, 'R0012');
  assert.deepEqual(approved.expectedOutput.fields, {});
  assert.equal(approved.expectedOutput.rendered, 'STATIC PRODUCT CODE\nBBD: 18/06/2027 04:32:08');
  assert.equal(db.prepare('SELECT next_run_number FROM product_masters WHERE id = ?').get(master.id).next_run_number, 13);
  db.close();
});

test('one product master renders a different approved message for each printer', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('multi-planner', 'planner');
  const reviewer = actor('multi-reviewer', 'qa');
  const master = createProductMaster({
    productCode: 'MULTICODE', displayName: 'Multi-printer product', nextRunNumber: 8,
    specification: {
      runPrefix: 'T', runWidth: 4,
      printerConfigurations: [
        {
          printerId: 'coder-1', messageId: 'can-code',
          fieldMappings: [{ fieldKey: 'run', source: 'run_code' }, { fieldKey: 'batch', source: 'brew_sheet_product' }],
          dateRule: { type: 'offset-months', months: 12, format: 'DD/MM/YYYY' },
          timeRule: { type: 'production-time', format: 'HH:mm:ss' },
          previewLines: ['{{run}} {{batch}}', 'BBD: {{bestBeforeDate}}']
        },
        {
          printerId: 'coder-2', messageId: 'case-code',
          fieldMappings: [{ fieldKey: 'product', source: 'brew_sheet_product' }],
          dateRule: { type: 'offset-months', months: 6, format: 'YYYY-MM-DD' },
          timeRule: { type: 'production-time', format: 'HH:mm' },
          previewLines: ['CASE {{product}} {{bestBeforeDate}}']
        }
      ]
    }
  }, reviewer, db);
  const draft = createBatchRelease({ ...releaseInput(master.id, 'MULTI-50'), printerIds: ['coder-1', 'coder-2'] }, planner, db);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  const prepared = reserveBatchReleaseRun(draft.id, db);

  assert.equal(prepared.expectedOutput.byPrinter['coder-1'].messageId, 'can-code');
  assert.deepEqual(prepared.expectedOutput.byPrinter['coder-1'].fields, { run: 'T0008', batch: 'MULTI-50' });
  assert.equal(prepared.expectedOutput.byPrinter['coder-1'].rendered, 'T0008 MULTI-50\nBBD: 18/06/2027');
  assert.equal(prepared.expectedOutput.byPrinter['coder-2'].messageId, 'case-code');
  assert.deepEqual(prepared.expectedOutput.byPrinter['coder-2'].fields, { product: 'MULTI-50' });
  assert.equal(prepared.expectedOutput.byPrinter['coder-2'].rendered, 'CASE MULTI-50 2026-12-18');
  beginBatchReleaseTarget(draft.id, 'coder-1', planner, {}, db);
  finishBatchReleaseTarget(draft.id, 'coder-1', { ok: true, messageMatches: true }, db);
  assert.equal(verifyBatchReleaseTarget(draft.id, 'coder-1', { passed: true }, planner, db).status, 'running');
  assert.doesNotThrow(() => beginBatchReleaseTarget(draft.id, 'coder-2', planner, {}, db));
  const updated = updateProductMaster(master.id, {
    displayName: 'Multi-printer product revised', nextRunNumber: 20,
    specification: {
      ...master.specification,
      printerConfigurations: master.specification.printerConfigurations.map((configuration) => configuration.printerId === 'coder-2'
        ? { ...configuration, messageId: 'case-code-v2' }
        : configuration)
    }
  }, reviewer, db);
  assert.equal(updated.currentVersion, 2);
  assert.equal(updated.nextRunNumber, 20);
  assert.equal(updated.specification.printerConfigurations[1].messageId, 'case-code-v2');
  assert.equal(getBatchRelease(draft.id, db).productMasterVersion, 1);
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
  reserveBatchReleaseRun(draft.id, db);

  const applying = beginBatchReleaseTarget(draft.id, 'coder-1', operator, {}, db);
  assert.equal(applying.status, 'applying');
  assert.equal(applying.executionTargets[0].appliedByUsername, operator.username);
  const awaiting = finishBatchReleaseTarget(draft.id, 'coder-1', { ok: true, messageMatches: true }, db);
  assert.equal(awaiting.status, 'awaiting_print_check');
  const completed = verifyBatchReleaseTarget(draft.id, 'coder-1', { passed: true }, operator, db);
  assert.equal(completed.status, 'running');
  assert.equal(completed.executionTargets[0].verifiedByUsername, operator.username);
  assert.equal(endBatchReleaseTargetRun(draft.id, 'coder-1', operator, db).status, 'completed');
  const reapplying = beginBatchReleaseTarget(draft.id, 'coder-1', operator, { reapply: true, reason: 'Return to previous product' }, db);
  assert.equal(reapplying.status, 'applying');
  assert.equal(reapplying.runCode, 'T0007');
  db.close();
});

test('failed first print returns to an editable release and preserves the consumed run', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-correction', 'planner');
  const reviewer = actor('qa-correction', 'qa');
  const operator = actor('operator-correction', 'operator');
  const master = createProductMaster(masterInput('CORRECT', 30), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'CORRECT-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  reserveBatchReleaseRun(draft.id, db);
  beginBatchReleaseTarget(draft.id, 'coder-1', operator, {}, db);
  finishBatchReleaseTarget(draft.id, 'coder-1', { ok: true, messageMatches: true }, db);
  verifyBatchReleaseTarget(draft.id, 'coder-1', { passed: false, reason: 'Printed batch is wrong' }, operator, db);

  const returned = returnBatchReleaseForReview(draft.id, 'Correct the approved batch value', operator, db);
  assert.equal(returned.status, 'rejected');
  const corrected = updateBatchRelease(draft.id, { ...releaseInput(master.id, 'CORRECT-02') }, planner, db);
  assert.equal(corrected.status, 'draft');
  assert.equal(corrected.runCode, 'T0030');
  submitBatchRelease(draft.id, planner, db);
  const reapproved = approveBatchRelease(draft.id, reviewer, db);
  assert.equal(reapproved.runCode, 'T0030');
  assert.equal(reapproved.executionTargets[0].status, 'pending');
  db.close();
});

test('switching releases ends the previous running target on that printer', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-switch', 'planner');
  const reviewer = actor('qa-switch', 'qa');
  const operator = actor('operator-switch', 'operator');
  const master = createProductMaster(masterInput('SWITCH', 40), reviewer, db);
  const makeRunning = (product) => {
    const release = createBatchRelease(releaseInput(master.id, product), planner, db);
    submitBatchRelease(release.id, planner, db);
    approveBatchRelease(release.id, reviewer, db);
    reserveBatchReleaseRun(release.id, db);
    beginBatchReleaseTarget(release.id, 'coder-1', operator, {}, db);
    finishBatchReleaseTarget(release.id, 'coder-1', { ok: true, messageMatches: true }, db);
    return verifyBatchReleaseTarget(release.id, 'coder-1', { passed: true }, operator, db);
  };
  const first = makeRunning('SWITCH-01');
  const second = createBatchRelease(releaseInput(master.id, 'SWITCH-02'), planner, db);
  submitBatchRelease(second.id, planner, db);
  approveBatchRelease(second.id, reviewer, db);
  reserveBatchReleaseRun(second.id, db);
  beginBatchReleaseTarget(second.id, 'coder-1', operator, {}, db);
  assert.deepEqual(endOtherRunningTargets('coder-1', second.id, db), [first.id]);
  assert.equal(getBatchRelease(first.id, db).status, 'completed');
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
  reserveBatchReleaseRun(draft.id, db);
  beginBatchReleaseTarget(draft.id, 'coder-1', operator, {}, db);

  assert.equal(recoverInterruptedBatchReleaseTargets(db), 1);
  const recovered = getBatchRelease(draft.id, db);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.executionTargets[0].status, 'failed');
  assert.match(recovered.executionTargets[0].error, /confirm the printer state/i);
  db.close();
});

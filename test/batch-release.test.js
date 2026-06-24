import assert from 'node:assert/strict';
import test from 'node:test';

const { openDatabase, runMigrations } = await import('../server/db.js');
const { createProductMaster, updateProductMaster } = await import('../server/repositories/product-master-repository.js');
const { upsertMessage } = await import('../server/repositories/message-repository.js');
const { upsertPrinter } = await import('../server/repositories/printer-repository.js');
const {
  approveBatchRelease,
  beginBatchReleaseTarget,
  claimBatchReleaseReview,
  createBatchRelease,
  deleteDraftBatchRelease,
  endBatchReleaseTargetRun,
  endOtherRunningTargets,
  finishBatchReleaseTarget,
  getBatchRelease,
  listBatchReleasesPage,
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
      defaultBrewSheetProduct: productCode,
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

  assert.throws(
    () => createBatchRelease(releaseInput(tbundrc.id, 'SMGOLD-370/371'), planner, db),
    /selected product code/i
  );

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

  const otherDraft = createBatchRelease(releaseInput(smgold.id, 'SMGOLD-370/371'), planner, db);
  assert.equal(otherDraft.brewSheetProduct, 'SMGOLD-370/371');
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

test('an approved release must be returned with a reason before correction', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-correction', 'planner');
  const reviewer = actor('qa-correction', 'qa');
  const master = createProductMaster(masterInput('CORRECT', 10), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'CORRECT-OLD'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  const approved = approveBatchRelease(draft.id, reviewer, db);
  assert.equal(approved.status, 'released');
  assert.equal(approved.executionTargets.length, 1);

  assert.throws(() => updateBatchRelease(draft.id, releaseInput(master.id, 'QUIET-EDIT'), planner, db), /approved releases are locked/i);
  const returned = returnBatchReleaseForReview(draft.id, 'BATCH was entered incorrectly.', reviewer, db);
  assert.equal(returned.status, 'rejected');
  assert.equal(returned.rejectionReason, 'BATCH was entered incorrectly.');

  const corrected = updateBatchRelease(draft.id, {
    ...releaseInput(master.id, 'CORRECT-NEW'),
    brewNumber: 'H0999'
  }, planner, db);
  assert.equal(corrected.status, 'draft');
  assert.equal(corrected.brewSheetProduct, 'CORRECT-NEW');
  assert.equal(corrected.brewNumber, 'H0999');
  assert.equal(corrected.reviewedByUsername, null);
  assert.equal(corrected.executionTargets.length, 1);
  db.close();
});

test('an approved release cannot be edited after printer execution starts', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-started', 'planner');
  const reviewer = actor('qa-started', 'qa');
  const operator = actor('operator-started', 'operator');
  const master = createProductMaster(masterInput('STARTED', 10), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'STARTED-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  beginBatchReleaseTarget(draft.id, 'coder-1', operator, {}, db);
  assert.throws(() => updateBatchRelease(draft.id, releaseInput(master.id, 'CHANGED'), planner, db), /approved releases are locked/i);
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
      printerConfigurations: [{
        printerId: 'coder-1', messageId: 'plain-message', fieldMappings: [],
        dateRule: { type: 'offset-months', months: 12, format: 'DD/MM/YYYY' },
        timeRule: { type: 'production-time', format: 'HH:mm:ss' },
        previewLines: ['STATIC PRODUCT CODE', 'BBD: {{bestBeforeDate}} {{productionTime}}']
      }]
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
  const draft = createBatchRelease({ ...releaseInput(master.id, 'MULTICODE-50'), printerIds: ['coder-1'] }, planner, db);
  assert.deepEqual(draft.printerIds, ['coder-1', 'coder-2']);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  const prepared = reserveBatchReleaseRun(draft.id, db);

  assert.equal(prepared.expectedOutput.byPrinter['coder-1'].messageId, 'can-code');
  assert.deepEqual(prepared.expectedOutput.byPrinter['coder-1'].fields, { run: 'T0008', batch: 'MULTICODE-50' });
  assert.equal(prepared.expectedOutput.byPrinter['coder-1'].rendered, 'T0008 MULTICODE-50\nBBD: 18/06/2027');
  assert.equal(prepared.expectedOutput.byPrinter['coder-2'].messageId, 'case-code');
  assert.deepEqual(prepared.expectedOutput.byPrinter['coder-2'].fields, { product: 'MULTICODE-50' });
  assert.equal(prepared.expectedOutput.byPrinter['coder-2'].rendered, 'CASE MULTICODE-50 2026-12-18');
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

test('disabled printers are skipped when a release is raised from a multi-printer master', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-skip-disabled', 'planner');
  const reviewer = actor('qa-skip-disabled', 'qa');
  for (const [index, printer] of [
    { id: 'coder-1', name: 'Can Coder', enabled: true },
    { id: 'coder-2', name: 'Case Coder', enabled: false },
    { id: 'coder-3', name: 'Bottle Coder', enabled: true }
  ].entries()) {
    upsertPrinter({
      ...printer,
      location: 'Line 1',
      host: '127.0.0.1',
      port: 9100 + index,
      mode: 'emulator',
      protocol: 'wsi',
      model: '1620',
      readbackMode: 'auto'
    }, db);
  }
  const input = masterInput('SKIPDIS', 12);
  input.specification.printerConfigurations = [
    { ...input.specification.printerConfigurations[0], printerId: 'coder-1', messageId: 'skip-can' },
    { ...input.specification.printerConfigurations[0], printerId: 'coder-2', messageId: 'skip-case' },
    { ...input.specification.printerConfigurations[0], printerId: 'coder-3', messageId: 'skip-bottle' }
  ];
  const master = createProductMaster(input, reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'SKIPDIS-01'), planner, db);

  assert.deepEqual(draft.printerIds, ['coder-1', 'coder-3']);
  submitBatchRelease(draft.id, planner, db);
  const approved = approveBatchRelease(draft.id, reviewer, db);
  assert.deepEqual(approved.executionTargets.map((target) => target.printerId), ['coder-1', 'coder-3']);
  const prepared = reserveBatchReleaseRun(draft.id, db);
  assert.deepEqual(Object.keys(prepared.expectedOutput.byPrinter).sort(), ['coder-1', 'coder-3']);
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
  updateProductMaster(master.id, { displayName: 'New master version', specification: master.specification }, reviewer, db);
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
  assert.equal(corrected.productMasterVersion, 1);
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

test('a running target can be resent for reverify after a mismatch response', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-reverify', 'planner');
  const reviewer = actor('qa-reverify', 'qa');
  const operator = actor('operator-reverify', 'operator');
  const master = createProductMaster(masterInput('REVERIFY', 11), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'REVERIFY-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  reserveBatchReleaseRun(draft.id, db);
  beginBatchReleaseTarget(draft.id, 'coder-1', operator, {}, db);
  finishBatchReleaseTarget(draft.id, 'coder-1', { ok: true, messageMatches: true }, db);
  const running = verifyBatchReleaseTarget(draft.id, 'coder-1', { passed: true }, operator, db);
  assert.equal(running.status, 'running');
  assert.throws(
    () => beginBatchReleaseTarget(draft.id, 'coder-1', operator, { reverify: true }, db),
    /mismatch response/i
  );
  const reverifying = beginBatchReleaseTarget(draft.id, 'coder-1', operator, {
    reverify: true,
    reason: 'Stopped production after message mismatch; resend approved release and reverify.'
  }, db);
  assert.equal(reverifying.status, 'applying');
  const awaiting = finishBatchReleaseTarget(draft.id, 'coder-1', { ok: true, messageMatches: true, reverify: true }, db);
  assert.equal(awaiting.status, 'awaiting_print_check');
  const reverified = verifyBatchReleaseTarget(draft.id, 'coder-1', { passed: true }, operator, db);
  assert.equal(reverified.status, 'running');
  assert.equal(reverified.runCode, 'T0011');
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

test('a failed target can be safely retried when another printer target is already running', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-partial', 'planner');
  const reviewer = actor('qa-partial', 'qa');
  const operator = actor('operator-partial', 'operator');
  const input = masterInput('PARTIAL', 1);
  input.specification.printerConfigurations.push({
    ...input.specification.printerConfigurations[0],
    printerId: 'coder-2',
    messageId: 'partial-case-message'
  });
  const master = createProductMaster(input, reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'PARTIAL-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  reserveBatchReleaseRun(draft.id, db);

  beginBatchReleaseTarget(draft.id, 'coder-1', operator, {}, db);
  finishBatchReleaseTarget(draft.id, 'coder-1', { ok: true, messageMatches: true }, db);
  verifyBatchReleaseTarget(draft.id, 'coder-1', { passed: true }, operator, db);
  beginBatchReleaseTarget(draft.id, 'coder-2', operator, {}, db);
  finishBatchReleaseTarget(draft.id, 'coder-2', { ok: true, messageMatches: true }, db);
  const failed = verifyBatchReleaseTarget(draft.id, 'coder-2', { passed: false, reason: 'Case print is unclear' }, operator, db);

  assert.equal(failed.status, 'running');
  assert.equal(failed.executionTargets.find((target) => target.printerId === 'coder-2').status, 'failed');
  assert.throws(
    () => returnBatchReleaseForReview(draft.id, 'Change the approved data', operator, db),
    /partially completed release/i
  );
  const retrying = beginBatchReleaseTarget(draft.id, 'coder-2', operator, {
    reason: 'Physical printer check completed; resend approved case message.'
  }, db);
  assert.equal(retrying.executionTargets.find((target) => target.printerId === 'coder-2').status, 'applying');
  assert.equal(retrying.executionTargets.find((target) => target.printerId === 'coder-1').status, 'running');
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

test('retrying an uncertain send requires a recorded physical printer check', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-uncertain', 'planner');
  const reviewer = actor('qa-uncertain', 'qa');
  const operator = actor('operator-uncertain', 'operator');
  const master = createProductMaster(masterInput('UNCERTAIN', 1), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'UNCERTAIN-01'), planner, db);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  beginBatchReleaseTarget(draft.id, 'coder-1', operator, {}, db);
  finishBatchReleaseTarget(draft.id, 'coder-1', { ok: false, error: 'Socket timed out' }, db);
  assert.throws(() => beginBatchReleaseTarget(draft.id, 'coder-1', operator, {}, db), /physical printer state/i);
  assert.equal(beginBatchReleaseTarget(draft.id, 'coder-1', operator, { reason: 'Checked printer; old message is still selected.' }, db).executionTargets[0].status, 'applying');
  db.close();
});

test('release register pagination searches the full archive and returns lifecycle counts', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const planner = actor('planner-pages', 'planner');
  const reviewer = actor('qa-pages', 'qa');
  const master = createProductMaster(masterInput('PAGED', 1), reviewer, db);
  for (let index = 1; index <= 31; index += 1) {
    createBatchRelease(releaseInput(master.id, `PAGED-${index}`), planner, db);
  }
  const first = listBatchReleasesPage({ limit: 25 }, db);
  assert.equal(first.items.length, 25);
  assert.equal(first.total, 31);
  assert.equal(first.counts.draft, 31);
  assert.equal(listBatchReleasesPage({ limit: 25, offset: 25 }, db).items.length, 6);
  const searched = listBatchReleasesPage({ limit: 25, search: 'PAGED-31' }, db);
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].brewSheetProduct, 'PAGED-31');
  db.close();
});

test('release output uses the latest saved message without bumping the master version', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const reviewer = actor('qa-live-message', 'qa');
  const planner = actor('planner-live-message', 'planner');
  const printerId = 'live-coder';
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO printers (id, name, location, host, port, mode, enabled, created_at, updated_at)
    VALUES (?, 'Live coder', 'Test line', '127.0.0.1', 19001, 'emulator', 1, ?, ?)`)
    .run(printerId, now, now);
  const message = {
    id: 'live-message', displayName: 'Live message', enabled: true,
    fields: [{ key: 'batch', label: 'BATCH', printerFieldName: 'BATCH', required: true, maxLength: 50, transform: 'uppercase' }],
    dateRule: { type: 'offset-months', months: 12, format: 'DD/MM/YYYY' },
    timeRule: { type: 'production-time', format: 'HH:mm:ss' },
    previewLines: ['OLD {{batch}}'],
    printerAssignments: [{ printerId, printerMessageName: 'LIVE', enabled: true }]
  };
  upsertMessage(message, db);
  const master = createProductMaster({
    productCode: 'LIVE', displayName: 'Live definition product', nextRunNumber: 1,
    specification: {
      runPrefix: 'T', runWidth: 4, defaultBrewSheetProduct: 'LIVE',
      printerConfigurations: [{
        printerId, messageId: message.id,
        fieldMappings: [{ fieldKey: 'batch', source: 'brew_sheet_product' }],
        dateRule: message.dateRule, timeRule: message.timeRule, previewLines: message.previewLines
      }]
    }
  }, reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'LIVE-42'), planner, db);

  upsertMessage({ ...message, previewLines: ['NEW {{batch}}'] }, db);
  submitBatchRelease(draft.id, planner, db);
  approveBatchRelease(draft.id, reviewer, db);
  const prepared = reserveBatchReleaseRun(draft.id, db);

  assert.equal(prepared.productMasterVersion, 1);
  assert.equal(prepared.expectedOutput.rendered, 'NEW LIVE-42');
  db.close();
});

test('draft releases can be deleted completely but submitted releases cannot', () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const reviewer = actor('qa-delete', 'qa');
  const planner = actor('planner-delete', 'planner');
  const master = createProductMaster(masterInput('DELETE', 1), reviewer, db);
  const draft = createBatchRelease(releaseInput(master.id, 'DELETE-1'), planner, db);
  db.prepare(`INSERT INTO audit_events (id, occurred_at, actor_username, action, target_type, target_id)
    VALUES ('delete-audit', ?, 'planner-delete', 'batch-release-created', 'batch-release', ?)`)
    .run(new Date().toISOString(), draft.id);

  assert.equal(deleteDraftBatchRelease(draft.id, db), true);
  assert.equal(getBatchRelease(draft.id, db), null);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_events WHERE target_type = 'batch-release' AND target_id = ?").get(draft.id).count, 0);

  const submitted = createBatchRelease(releaseInput(master.id, 'DELETE-2'), planner, db);
  submitBatchRelease(submitted.id, planner, db);
  assert.throws(() => deleteDraftBatchRelease(submitted.id, db), /only draft releases/i);
  db.close();
});

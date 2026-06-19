import assert from 'node:assert/strict';
import test from 'node:test';

const { openDatabase, runMigrations } = await import('../server/db.js');
const { createProductMaster, updateProductMaster } = await import('../server/repositories/product-master-repository.js');
const {
  approveBatchRelease,
  createBatchRelease,
  submitBatchRelease
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

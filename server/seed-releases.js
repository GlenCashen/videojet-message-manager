import { getDb } from './db.js';
import { listProductMasters } from './repositories/product-master-repository.js';
import {
  approveBatchRelease,
  beginBatchReleaseTarget,
  createBatchRelease,
  endBatchReleaseTargetRun,
  finishBatchReleaseTarget,
  reserveBatchReleaseRun,
  submitBatchRelease,
  verifyBatchReleaseTarget
} from './repositories/batch-release-repository.js';

const COMPLETED_COUNT = Number(process.env.SEED_COMPLETED_RELEASES || 100);
const RELEASED_COUNT = Number(process.env.SEED_RELEASED_RELEASES || 15);
const MASTER_CODE = String(process.env.SEED_MASTER_CODE || '').trim().toUpperCase();
const SEED_NOTE_PREFIX = 'Development release seed:';

function positiveCount(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error(`${label} must be an integer between 0 and 1000.`);
  return value;
}

function actor(username, roles) {
  return { username, roles, developmentIdentity: true };
}

function releaseInput(master, printerIds, sequence, state) {
  const planned = new Date(Date.now() + (state === 'released' ? sequence + 1 : -(sequence + 1)) * 86400000);
  return {
    productMasterId: master.id,
    brewSheetProduct: `${master.productCode}-${String(sequence + 1).padStart(3, '0')}`,
    brewNumber: `H${String(4000 + sequence).padStart(4, '0')}`,
    batchNumber: `BATCH-${String(sequence + 1).padStart(3, '0')}`,
    plannedProductionAt: planned.toISOString(),
    printerIds,
    notes: `${SEED_NOTE_PREFIX}${state}:${String(sequence + 1).padStart(3, '0')}`
  };
}

function seed() {
  const completedCount = positiveCount(COMPLETED_COUNT, 'SEED_COMPLETED_RELEASES');
  const releasedCount = positiveCount(RELEASED_COUNT, 'SEED_RELEASED_RELEASES');
  const db = getDb();
  const masters = listProductMasters({ enabledOnly: true }, db);
  const master = MASTER_CODE ? masters.find((item) => item.productCode === MASTER_CODE) : masters[0];
  if (!master) throw new Error(MASTER_CODE ? `Enabled product master ${MASTER_CODE} was not found.` : 'Create an enabled product master before seeding releases.');
  const printerIds = (master.specification?.printerConfigurations || []).map((configuration) => configuration.printerId);
  if (!printerIds.length) throw new Error(`Product master ${master.productCode} has no configured printers.`);

  const planner = actor('development-seed-planner', ['planner']);
  const reviewer = actor('development-seed-reviewer', ['qa']);
  const operator = actor('development-seed-operator', ['operator']);

  db.transaction(() => {
    db.prepare('DELETE FROM batch_releases WHERE notes LIKE ?').run(`${SEED_NOTE_PREFIX}%`);

    for (let index = 0; index < completedCount; index += 1) {
      const release = createBatchRelease(releaseInput(master, printerIds, index, 'completed'), planner, db);
      submitBatchRelease(release.id, planner, db);
      approveBatchRelease(release.id, reviewer, db);
      reserveBatchReleaseRun(release.id, db);
      for (const printerId of printerIds) {
        beginBatchReleaseTarget(release.id, printerId, operator, {}, db);
        finishBatchReleaseTarget(release.id, printerId, { ok: true, messageMatches: true, seeded: true }, db);
        verifyBatchReleaseTarget(release.id, printerId, { passed: true }, operator, db);
        endBatchReleaseTargetRun(release.id, printerId, operator, db);
      }
    }

    for (let index = 0; index < releasedCount; index += 1) {
      const release = createBatchRelease(releaseInput(master, printerIds, completedCount + index, 'released'), planner, db);
      submitBatchRelease(release.id, planner, db);
      approveBatchRelease(release.id, reviewer, db);
    }
  })();

  const counts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM batch_releases
    WHERE notes LIKE ? GROUP BY status ORDER BY status
  `).all(`${SEED_NOTE_PREFIX}%`);
  console.log(`Seeded releases for ${master.productCode} across ${printerIds.length} printer(s).`);
  for (const row of counts) console.log(`${row.status}: ${row.count}`);
}

try {
  seed();
} catch (error) {
  console.error(`Release seed failed: ${error.message}`);
  process.exitCode = 1;
}

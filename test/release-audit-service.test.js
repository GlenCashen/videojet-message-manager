import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseAuditService } from '../server/services/release-audit-service.js';

function createHarness() {
  const logs = [];
  const service = createReleaseAuditService({
    addLog: (entry) => logs.push(entry),
    auditActor: (actor) => ({
      actor: actor.username,
      actorUserId: actor.developmentIdentity ? null : (actor.id || null)
    })
  });
  return { logs, service };
}

function release(overrides = {}) {
  return {
    id: 'release-1',
    productMasterId: 'master-1',
    brewSheetProduct: 'TBUNDRC-44',
    brewNumber: 'BREW-99',
    runNumber: 44,
    runCode: 'T0044',
    status: 'released',
    ...overrides
  };
}

const actor = { id: 'user-1', username: 'operator-one' };
const printer = { id: 'coder-1' };

function assertReleaseAuditEnvelope(entry, action, expectedDetails = {}) {
  assert.equal(entry.action, action);
  assert.equal(entry.actor, 'operator-one');
  assert.equal(entry.actorUserId, 'user-1');
  assert.equal(entry.targetType, 'batch-release');
  assert.equal(entry.targetId, 'release-1');
  assert.equal(entry.printerId, Object.hasOwn(expectedDetails, 'printerId') ? expectedDetails.printerId : 'coder-1');
  assert.equal(entry.details.releaseId, 'release-1');
  assert.equal(entry.details.productMasterId, 'master-1');
  assert.equal(entry.details.brewSheetProduct, 'TBUNDRC-44');
  assert.equal(entry.details.brewNumber, 'BREW-99');
  assert.equal(entry.details.runNumber, 44);
  assert.equal(entry.details.runCode, 'T0044');
  assert.equal(entry.details.releaseStatus, expectedDetails.releaseStatus ?? 'released');
  for (const [key, value] of Object.entries(expectedDetails)) {
    if (key !== 'releaseStatus') assert.deepEqual(entry.details[key], value, `${action} details.${key}`);
  }
}

test('release audit service records successful production traceability details', () => {
  const { logs, service } = createHarness();
  const currentRelease = release();

  service.runAssigned(actor, currentRelease, printer);
  service.applicationStarted(actor, currentRelease, printer, {
    reapply: true,
    reverify: false,
    reason: 'Physical printer checked before retry'
  });
  service.agentJobQueued(actor, currentRelease, printer, { id: 'job-1', payloadHash: 'hash-1' });
  service.applicationFinished(actor, release({ status: 'awaiting_print_check' }), printer, {
    ok: true,
    messageMatches: true,
    operationId: 'op-1',
    selectedMessage: 'BUNDY 15 MONTH.job',
    requestedMessage: 'BUNDY 15 MONTH.job',
    verificationAvailable: true,
    rawStatus: '0000002'
  });
  service.printChecked(actor, release({ status: 'running' }), 'coder-1', { passed: true, reverify: false });
  service.productionRunning(actor, release({ status: 'running' }), 'coder-1', { reverify: false });
  service.runEnded(actor, release({ status: 'completed' }), 'coder-1');

  assert.equal(logs.length, 7);
  assertReleaseAuditEnvelope(logs[0], 'batch-release-run-assigned', { ok: true });
  assertReleaseAuditEnvelope(logs[1], 'batch-release-application-started', {
    reapply: true,
    reverify: false,
    reason: 'Physical printer checked before retry',
    ok: true
  });
  assertReleaseAuditEnvelope(logs[2], 'batch-release-agent-job-queued', {
    jobId: 'job-1',
    payloadHash: 'hash-1',
    ok: true
  });
  assertReleaseAuditEnvelope(logs[3], 'batch-release-application-sent', {
    releaseStatus: 'awaiting_print_check',
    operationId: 'op-1',
    selectedMessage: 'BUNDY 15 MONTH.job',
    requestedMessage: 'BUNDY 15 MONTH.job',
    messageMatches: true,
    verificationAvailable: true,
    rawStatus: '0000002',
    reverify: false,
    operatorMessage: null,
    technicalMessage: null,
    ok: true
  });
  assertReleaseAuditEnvelope(logs[4], 'batch-release-print-verified', {
    releaseStatus: 'running',
    reason: null,
    reverify: false,
    ok: true
  });
  assertReleaseAuditEnvelope(logs[5], 'batch-release-running', {
    releaseStatus: 'running',
    status: 'running',
    reverify: false,
    ok: true
  });
  assertReleaseAuditEnvelope(logs[6], 'batch-release-run-ended', {
    releaseStatus: 'completed',
    status: 'completed',
    ok: true
  });
});

test('release audit service records reverify, failure, return, and switch details', () => {
  const { logs, service } = createHarness();

  service.applicationStarted(actor, release({ status: 'running' }), printer, {
    reverify: true,
    reason: 'STOP PRODUCTION: mismatch detected, product quarantined, printer physically checked'
  });
  service.applicationFinished(actor, release({ status: 'failed' }), printer, {
    ok: false,
    messageMatches: false,
    operationId: 'op-fail',
    requestedMessage: 'EXPECTED.job',
    selectedMessage: 'WRONG.job',
    operatorMessage: 'STOP PRODUCTION. Quarantine affected product and reverify before restarting.',
    technicalMessage: 'Selected printer message did not match expected message.'
  }, { reverify: true });
  service.applicationFailed(actor, 'release-1', 'coder-1', {
    operatorMessage: 'Physically check printer and record reason before retry.',
    technicalMessage: 'TCP timeout while sending approved release.'
  }, 'failed');
  service.printChecked(actor, release({ status: 'failed' }), 'coder-1', {
    passed: false,
    reason: 'First print BATCH number is wrong',
    reverify: true
  });
  service.returnedForReview(actor, release({ status: 'rejected', rejectionReason: 'Incorrect approved brew number' }));
  service.runEndedBySwitch(actor, 'release-ended', printer, release({ id: 'release-replacement', status: 'running' }));
  service.agentApplicationFinished({ id: 'agent-1' }, release({ status: 'failed' }), 'coder-1', {
    ok: false,
    reverify: true,
    operatorMessage: 'STOP PRODUCTION. Quarantine affected product and physically check printer.',
    technicalMessage: 'Agent reported printer mismatch.'
  }, { id: 'job-agent-1', payloadHash: 'hash-agent-1' });

  assert.equal(logs.length, 7);
  assertReleaseAuditEnvelope(logs[0], 'batch-release-reverify-started', {
    releaseStatus: 'running',
    reapply: false,
    reverify: true,
    reason: 'STOP PRODUCTION: mismatch detected, product quarantined, printer physically checked',
    ok: true
  });
  assertReleaseAuditEnvelope(logs[1], 'batch-release-printer-state-uncertain', {
    releaseStatus: 'failed',
    operationId: 'op-fail',
    requestedMessage: 'EXPECTED.job',
    selectedMessage: 'WRONG.job',
    messageMatches: false,
    reverify: true,
    operatorMessage: 'STOP PRODUCTION. Quarantine affected product and reverify before restarting.',
    technicalMessage: 'Selected printer message did not match expected message.',
    ok: false
  });
  assert.equal(logs[1].error, 'Selected printer message did not match expected message.');

  assert.equal(logs[2].action, 'batch-release-printer-state-uncertain');
  assert.equal(logs[2].actor, 'operator-one');
  assert.equal(logs[2].targetId, 'release-1');
  assert.equal(logs[2].printerId, 'coder-1');
  assert.equal(logs[2].error, 'TCP timeout while sending approved release.');
  assert.equal(logs[2].details.operatorMessage, 'Physically check printer and record reason before retry.');
  assert.equal(logs[2].details.technicalMessage, 'TCP timeout while sending approved release.');
  assert.equal(logs[2].details.status, 'failed');
  assert.equal(logs[2].details.ok, false);

  assertReleaseAuditEnvelope(logs[3], 'batch-release-print-failed', {
    releaseStatus: 'failed',
    reason: 'First print BATCH number is wrong',
    reverify: true,
    ok: false
  });
  assertReleaseAuditEnvelope(logs[4], 'batch-release-returned-for-review', {
    printerId: null,
    releaseStatus: 'rejected',
    reason: 'Incorrect approved brew number',
    status: 'rejected',
    ok: true
  });

  assert.equal(logs[5].action, 'batch-release-run-ended-by-switch');
  assert.equal(logs[5].targetId, 'release-ended');
  assert.equal(logs[5].printerId, 'coder-1');
  assert.equal(logs[5].details.releaseId, 'release-ended');
  assert.equal(logs[5].details.replacedByReleaseId, 'release-replacement');
  assert.equal(logs[5].details.replacedByRunCode, 'T0044');
  assert.equal(logs[5].details.replacementReleaseStatus, 'running');
  assert.equal(logs[5].details.ok, true);

  assert.equal(logs[6].action, 'batch-release-printer-state-uncertain');
  assert.equal(logs[6].actor, 'agent:agent-1');
  assert.equal(logs[6].actorUserId, null);
  assert.equal(logs[6].targetId, 'release-1');
  assert.equal(logs[6].printerId, 'coder-1');
  assert.equal(logs[6].error, 'Agent reported printer mismatch.');
  assert.equal(logs[6].details.agentId, 'agent-1');
  assert.equal(logs[6].details.jobId, 'job-agent-1');
  assert.equal(logs[6].details.payloadHash, 'hash-agent-1');
  assert.equal(logs[6].details.releaseStatus, 'failed');
  assert.equal(logs[6].details.status, 'failed');
  assert.equal(logs[6].details.reverify, true);
  assert.equal(logs[6].details.operatorMessage, 'STOP PRODUCTION. Quarantine affected product and physically check printer.');
  assert.equal(logs[6].details.technicalMessage, 'Agent reported printer mismatch.');
  assert.equal(logs[6].details.ok, false);
});

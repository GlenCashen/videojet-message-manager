import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrinterRuntimeService } from '../server/services/printer-runtime-service.js';

const release = {
  id: 'release-1',
  plannedProductionAt: '2026-06-18T04:32:08.000Z',
  runCode: 'T0044'
};
const printer = { id: 'coder-1' };
const execution = {
  expectedOutput: {
    messageId: 'bundy-15-month',
    fields: { BATCH: 'T0044', BREW: 'H0477' },
    rendered: 'T0044TBUNDRC-44\nBBD: 18/09/2027 04:32:08'
  }
};
const user = { id: 'operator-1', username: 'operator-one' };

function createHarness({ sendResult = { ok: true, messageMatches: true } } = {}) {
  const calls = [];
  const updatedRelease = { id: release.id, status: 'awaiting_print_check' };
  const service = createPrinterRuntimeService({
    addLog: (...args) => calls.push(['addLog', ...args]),
    auditActor: (actor) => ({
      actor: actor.username,
      actorUserId: actor.developmentIdentity ? null : (actor.id || null)
    }),
    setPrinterMessage: async (...args) => {
      calls.push(['setPrinterMessage', ...args]);
      return sendResult;
    },
    insertMessageUpdateEvent: (...args) => calls.push(['insertMessageUpdateEvent', ...args]),
    persistExpectedOutput: async (...args) => calls.push(['persistExpectedOutput', ...args]),
    releaseExecutionService: {
      finishApply: (...args) => {
        calls.push(['finishApply', ...args]);
        return { release: updatedRelease, endedReleaseIds: ['old-release-1'] };
      },
      markApplyFailed: (...args) => {
        calls.push(['markApplyFailed', ...args]);
        return { id: release.id, status: 'failed' };
      }
    },
    releaseAudit: {
      runEndedBySwitch: (...args) => calls.push(['runEndedBySwitch', ...args]),
      applicationFinished: (...args) => calls.push(['applicationFinished', ...args]),
      agentApplicationFinished: (...args) => calls.push(['agentApplicationFinished', ...args]),
      applicationFailed: (...args) => calls.push(['applicationFailed', ...args])
    }
  });
  return { calls, service, updatedRelease };
}

test('applyReleaseLocally sends the printer update, persists output, finishes state, and audits', async () => {
  const expectedOutput = { messageId: 'bundy-15-month', fields: { BATCH: 'T0044' } };
  const sendResult = {
    ok: true,
    messageMatches: true,
    operationId: 'op-1',
    expectedOutput
  };
  const { calls, service, updatedRelease } = createHarness({ sendResult });

  const response = await service.applyReleaseLocally({ release, printer, execution, user, reverify: true });

  assert.equal(response.release, updatedRelease);
  assert.deepEqual(response.endedReleaseIds, ['old-release-1']);
  assert.equal(response.result.reverify, true);

  assert.deepEqual(calls[0], ['setPrinterMessage', printer, {
    messageId: execution.expectedOutput.messageId,
    fields: execution.expectedOutput.fields,
    productionDate: release.plannedProductionAt
  }]);
  assert.deepEqual(calls[1], ['insertMessageUpdateEvent', { ...sendResult, reverify: true }, user]);
  assert.deepEqual(calls[2], ['persistExpectedOutput', 'coder-1', expectedOutput]);
  assert.deepEqual(calls[3], ['finishApply', {
    releaseId: 'release-1',
    printerId: 'coder-1',
    result: { ...sendResult, reverify: true }
  }]);
  assert.deepEqual(calls[4], ['runEndedBySwitch', user, 'old-release-1', printer, release]);
  assert.deepEqual(calls[5], ['applicationFinished', user, updatedRelease, printer, { ...sendResult, reverify: true }, { reverify: true }]);
});

test('applyReleaseLocally does not persist expected output after an uncertain send', async () => {
  const sendResult = {
    ok: false,
    messageMatches: false,
    operatorMessage: 'STOP PRODUCTION. Quarantine affected product and physically check printer.',
    technicalMessage: 'Selected printer message did not match expected message.'
  };
  const { calls, service } = createHarness({ sendResult });

  const response = await service.applyReleaseLocally({ release, printer, execution, user, reverify: false });

  assert.equal(response.result.ok, false);
  assert.equal(response.result.reverify, false);
  assert.equal(calls.some(([name]) => name === 'persistExpectedOutput'), false);
  assert.ok(calls.some(([name]) => name === 'finishApply'));
  assert.ok(calls.some(([name]) => name === 'applicationFinished'));
});

test('completeAgentManualJob records manual agent success with operator audit context', async () => {
  const { calls, service } = createHarness();
  const agent = { id: 'agent-1' };
  const job = {
    id: 'manual-job-1',
    jobType: 'manual',
    printerId: 'coder-1',
    context: {
      actorUserId: 'operator-1',
      actorUsername: 'operator-one',
      reason: 'Approved manual exception for maintenance test'
    }
  };
  const expectedOutput = { printerMessageName: 'BUNDY 15 MONTH.job', fields: { BATCH: 'T0044' } };
  const result = {
    ok: true,
    messageMatches: true,
    operationId: 'manual-job-1',
    requestedMessage: 'BUNDY 15 MONTH.job',
    selectedMessage: 'BUNDY 15 MONTH.job',
    rawStatus: '0000002',
    fieldResults: [{ field: 'BATCH', ok: true }],
    expectedOutput
  };

  const response = await service.completeAgentManualJob({ agent, job, result });

  assert.equal(response.job, job);
  assert.equal(response.result, result);
  assert.deepEqual(calls[0], ['insertMessageUpdateEvent', result, { id: 'operator-1', username: 'operator-one', developmentIdentity: false }]);
  assert.deepEqual(calls[1], ['persistExpectedOutput', 'coder-1', expectedOutput]);
  assert.equal(calls[2][0], 'addLog');
  assert.deepEqual(calls[2][1], {
    action: 'message-update-success',
    actor: 'operator-one',
    actorUserId: 'operator-1',
    targetType: 'printer',
    targetId: 'coder-1',
    printerId: 'coder-1',
    operationId: 'manual-job-1',
    requestedMessage: 'BUNDY 15 MONTH.job',
    selectedMessage: 'BUNDY 15 MONTH.job',
    rawStatus: '0000002',
    decodedFaultCodes: [],
    fieldResults: [{ field: 'BATCH', ok: true }],
    error: null,
    details: {
      reason: 'Approved manual exception for maintenance test',
      mode: 'manual-exception',
      agentId: 'agent-1',
      jobId: 'manual-job-1',
      operatorMessage: null,
      technicalMessage: null
    }
  });
});

test('completeAgentManualJob records manual agent failure without persisting expected output', async () => {
  const { calls, service } = createHarness();
  const agent = { id: 'agent-1' };
  const job = {
    id: 'manual-job-2',
    jobType: 'manual',
    printerId: 'coder-1',
    context: { reason: 'Maintenance manual exception failed' }
  };
  const result = {
    ok: false,
    messageMatches: false,
    operationId: 'manual-job-2',
    requestedMessage: 'EXPECTED.job',
    selectedMessage: 'WRONG.job',
    operatorMessage: 'STOP PRODUCTION. Quarantine affected product and physically check printer.',
    technicalMessage: 'Manual agent selected message mismatch.'
  };

  await service.completeAgentManualJob({ agent, job, result });

  assert.equal(calls.some(([name]) => name === 'persistExpectedOutput'), false);
  assert.deepEqual(calls[0], ['insertMessageUpdateEvent', result, { id: null, username: 'agent:agent-1', developmentIdentity: true }]);
  assert.equal(calls[1][0], 'addLog');
  assert.equal(calls[1][1].action, 'message-update-failure');
  assert.equal(calls[1][1].actor, 'agent:agent-1');
  assert.equal(calls[1][1].actorUserId, null);
  assert.equal(calls[1][1].error, 'Manual agent selected message mismatch.');
  assert.equal(calls[1][1].details.reason, 'Maintenance manual exception failed');
  assert.equal(calls[1][1].details.operatorMessage, 'STOP PRODUCTION. Quarantine affected product and physically check printer.');
  assert.equal(calls[1][1].details.technicalMessage, 'Manual agent selected message mismatch.');
});

test('completeAgentReleaseApply records the agent result, persists output, finishes state, and audits', async () => {
  const { calls, service, updatedRelease } = createHarness();
  const agent = { id: 'agent-1' };
  const job = {
    id: 'job-1',
    releaseId: 'release-1',
    printerId: 'coder-1',
    payloadHash: 'hash-1'
  };
  const expectedOutput = { messageId: 'bundy-15-month', fields: { BATCH: 'T0044' } };
  const result = {
    ok: true,
    messageMatches: true,
    operationId: 'job-1',
    expectedOutput,
    reverify: true
  };

  const response = await service.completeAgentReleaseApply({ agent, job, result });

  assert.equal(response.release, updatedRelease);
  assert.deepEqual(response.endedReleaseIds, ['old-release-1']);
  assert.deepEqual(calls[0], ['insertMessageUpdateEvent', result, { username: 'agent:agent-1', developmentIdentity: true }]);
  assert.deepEqual(calls[1], ['persistExpectedOutput', 'coder-1', expectedOutput]);
  assert.deepEqual(calls[2], ['finishApply', { releaseId: 'release-1', printerId: 'coder-1', result }]);
  assert.deepEqual(calls[3], ['agentApplicationFinished', agent, updatedRelease, 'coder-1', result, job]);
});

test('completeAgentReleaseApply does not persist output after a failed agent result', async () => {
  const { calls, service } = createHarness();
  const agent = { id: 'agent-1' };
  const job = {
    id: 'job-1',
    releaseId: 'release-1',
    printerId: 'coder-1',
    payloadHash: 'hash-1'
  };
  const result = {
    ok: false,
    messageMatches: false,
    operatorMessage: 'STOP PRODUCTION. Quarantine affected product and physically check printer.',
    technicalMessage: 'Agent reported printer mismatch.'
  };

  await service.completeAgentReleaseApply({ agent, job, result });

  assert.equal(calls.some(([name]) => name === 'persistExpectedOutput'), false);
  assert.ok(calls.some(([name]) => name === 'finishApply'));
  assert.ok(calls.some(([name]) => name === 'agentApplicationFinished'));
});

test('markApplyFailed records the failed target state, message update event, and audit entry', () => {
  const { calls, service } = createHarness();
  const failure = {
    ok: false,
    printerId: 'coder-1',
    error: 'TCP timeout while sending release.',
    operatorMessage: 'Physically check printer and record a reason before retry.',
    technicalMessage: 'TCP timeout while sending release.'
  };

  const response = service.markApplyFailed({
    releaseId: 'release-1',
    printerId: 'coder-1',
    failure,
    user
  });

  assert.deepEqual(response.release, { id: 'release-1', status: 'failed' });
  assert.deepEqual(calls[0], ['markApplyFailed', { releaseId: 'release-1', printerId: 'coder-1', failure }]);
  assert.deepEqual(calls[1], ['insertMessageUpdateEvent', failure, user]);
  assert.deepEqual(calls[2], ['applicationFailed', user, 'release-1', 'coder-1', failure, 'failed']);
});

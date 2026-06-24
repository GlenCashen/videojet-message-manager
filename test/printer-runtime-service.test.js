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

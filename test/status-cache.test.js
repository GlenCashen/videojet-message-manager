import assert from 'node:assert/strict';
import test from 'node:test';
import { StatusCache } from '../server/status-cache.js';

test('starts with unknown stale state', () => {
  const cache = new StatusCache({ staleAfterMs: 5, offlineAfterFailures: 3 });
  cache.syncPrinters([{ id: 'coder-1' }]);
  const status = cache.get('coder-1');
  assert.equal(status.online, false);
  assert.equal(status.stale, true);
  assert.equal(status.busy, false);
  assert.equal(status.selectedMessage, null);
});

test('success transition resets failures and increments revision', () => {
  const cache = new StatusCache({ staleAfterMs: 1000, offlineAfterFailures: 3 });
  cache.syncPrinters([{ id: 'coder-1' }]);
  const before = cache.get('coder-1').revision;
  cache.applyFailure('coder-1', new Error('timeout'));
  const status = cache.applySuccess('coder-1', { selectedMessage: '9 MONTH', rawStatus: '0000001', responseTimeMs: 10 });
  assert.equal(status.online, true);
  assert.equal(status.consecutiveFailures, 0);
  assert.equal(status.lastError, null);
  assert.equal(status.selectedMessage, '9 MONTH');
  assert.equal(status.decodedStatus.alarm.label, 'Green');
  assert.ok(status.revision > before);
});

test('offline threshold waits for configured failures', () => {
  const cache = new StatusCache({ staleAfterMs: 1000, offlineAfterFailures: 3 });
  cache.syncPrinters([{ id: 'coder-1' }]);
  cache.applySuccess('coder-1', { selectedMessage: '9 MONTH', rawStatus: '0000001', responseTimeMs: 10 });
  cache.applyFailure('coder-1', new Error('one'));
  cache.applyFailure('coder-1', new Error('two'));
  assert.equal(cache.get('coder-1').online, true);
  cache.applyFailure('coder-1', new Error('three'));
  assert.equal(cache.get('coder-1').online, false);
});

test('a successful poll automatically recovers an offline printer', () => {
  const events = [];
  const transitions = [];
  const cache = new StatusCache({
    staleAfterMs: 1000,
    offlineAfterFailures: 3,
    onChange: (event, status) => events.push({ event, status }),
    onTransition: (transition, status) => transitions.push({ transition, status })
  });

  cache.syncPrinters([{ id: 'coder-1' }]);
  cache.applySuccess('coder-1', { selectedMessage: '9 MONTH', rawStatus: '0000001', responseTimeMs: 10 });
  cache.applyFailure('coder-1', new Error('timeout one'));
  cache.applyFailure('coder-1', new Error('timeout two'));
  cache.applyFailure('coder-1', new Error('timeout three'));

  const offline = cache.get('coder-1');
  assert.equal(offline.online, false);
  assert.equal(offline.consecutiveFailures, 3);
  assert.match(offline.lastError, /timeout three/);

  const recovered = cache.applySuccess('coder-1', {
    selectedMessage: '12 MONTH',
    rawStatus: '0000002',
    responseTimeMs: 12
  });

  assert.equal(recovered.online, true);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.selectedMessage, '12 MONTH');
  assert.equal(recovered.rawStatus, '0000002');
  assert.equal(recovered.decodedStatus.alarm.label, 'Amber');
  assert.ok(recovered.lastAttemptAt);
  assert.ok(recovered.lastSuccessfulAt);
  assert.ok(events.some(({ event, status }) => event === 'printer-status' && status.online === true && status.selectedMessage === '12 MONTH'));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition, 'offline -> online');

  cache.applySuccess('coder-1', {
    selectedMessage: '12 MONTH',
    rawStatus: '0000002',
    responseTimeMs: 10
  });
  assert.equal(transitions.length, 1);
});

test('expected output is included in status and preserved by polls', () => {
  const cache = new StatusCache({ staleAfterMs: 1000, offlineAfterFailures: 3 });
  cache.syncPrinters([{ id: 'coder-1' }]);
  const expectedOutput = {
    messageId: '12-month',
    displayName: '12 Month',
    printerMessageName: '12 MONTH',
    fields: { brew: 'BR1246' },
    lines: ['BR1246'],
    rendered: 'BR1246',
    generatedAt: '2026-06-17T04:32:08.000Z',
    source: 'last-applied'
  };

  cache.applySuccess('coder-1', {
    selectedMessage: '12 MONTH',
    rawStatus: '0000002',
    responseTimeMs: 10,
    expectedOutput
  });
  assert.deepEqual(cache.get('coder-1').expectedOutput, expectedOutput);

  cache.applySuccess('coder-1', {
    selectedMessage: '12 MONTH',
    rawStatus: '0000002',
    responseTimeMs: 10
  });
  assert.deepEqual(cache.get('coder-1').expectedOutput, expectedOutput);
});

test('status records when current-message verification is unsupported', () => {
  const cache = new StatusCache();
  cache.syncPrinters([{ id: 'coder-1710' }]);
  const status = cache.applySuccess('coder-1710', {
    messageVerification: 'unsupported',
    rawStatus: '0000001',
    responseTimeMs: 10
  });

  assert.equal(status.online, true);
  assert.equal(status.selectedMessage, null);
  assert.equal(status.messageVerification, 'unsupported');
});

test('status cache decodes NGPCL status packets when protocol is supplied', () => {
  const cache = new StatusCache();
  cache.syncPrinters([{ id: 'markem-1' }]);
  const status = cache.applySuccess('markem-1', {
    selectedMessage: 'Bundy 15 Month.job',
    messageVerification: 'verified',
    rawStatus: '{~DS0|0|0|1|1|0|2|0|000000000|09|1|}',
    protocol: 'ngpcl',
    responseTimeMs: 12
  });

  assert.equal(status.online, true);
  assert.equal(status.selectedMessage, 'Bundy 15 Month.job');
  assert.equal(status.decodedStatus.protocol, 'ngpcl');
  assert.equal(status.decodedStatus.alarm.primary, 'blue');
  assert.equal(status.decodedStatus.operatorStatus, 'Beam stop active');
});

test('successful unchanged polls broadcast fresh timestamps without changing revision', async () => {
  const events = [];
  const cache = new StatusCache({
    staleAfterMs: 1000,
    onChange: (event, status) => events.push({ event, status })
  });
  cache.syncPrinters([{ id: 'coder-1' }]);

  const first = cache.applySuccess('coder-1', {
    selectedMessage: '9 MONTH',
    rawStatus: '0000001',
    responseTimeMs: 10
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = cache.applySuccess('coder-1', {
    selectedMessage: '9 MONTH',
    rawStatus: '0000001',
    responseTimeMs: 10
  });

  assert.equal(events.length, 2);
  assert.equal(second.revision, first.revision);
  assert.notEqual(second.lastSuccessfulAt, first.lastSuccessfulAt);
});

test('stale calculation uses last successful timestamp', async () => {
  const cache = new StatusCache({ staleAfterMs: 5, offlineAfterFailures: 3 });
  cache.syncPrinters([{ id: 'coder-1' }]);
  cache.applySuccess('coder-1', { selectedMessage: '9 MONTH', rawStatus: '0000001', responseTimeMs: 10 });
  assert.equal(cache.get('coder-1').stale, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cache.get('coder-1').stale, true);
});

test('revision conflict helper detects stale revisions', () => {
  const cache = new StatusCache();
  cache.syncPrinters([{ id: 'coder-1' }]);
  const revision = cache.get('coder-1').revision;
  assert.equal(cache.hasRevision('coder-1', revision), true);
  cache.startOperation('coder-1', 'message-update', 'op-1');
  assert.equal(cache.hasRevision('coder-1', revision), false);
});

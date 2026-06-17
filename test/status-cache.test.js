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

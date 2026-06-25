import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STALE_AFTER_MS,
  isStale,
  statusLabel,
  statusTimestamp,
  statusTone
} from '../public/js/status-ui.js';

test('status freshness uses the last successful update instead of failed poll attempts', () => {
  const lastSuccessfulAt = new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString();
  const lastAttemptAt = new Date().toISOString();
  const status = {
    online: true,
    stale: false,
    lastSuccessfulAt,
    lastAttemptAt,
    consecutiveFailures: 1,
    lastError: 'timeout'
  };

  assert.equal(statusTimestamp(status), lastSuccessfulAt);
  assert.equal(isStale(status), true);
  assert.equal(statusTone(status), 'warning');
  assert.equal(statusLabel(status), 'Connection stale');
});

test('failed poll attempts without a success do not look like fresh printer data', () => {
  const status = {
    online: true,
    stale: false,
    lastAttemptAt: new Date().toISOString(),
    consecutiveFailures: 1,
    lastError: 'timeout'
  };

  assert.equal(statusTimestamp(status), null);
  assert.equal(isStale(status), false);
  assert.equal(statusTone(status), 'warning');
  assert.equal(statusLabel(status), 'Connection retrying');
});

test('message mismatch remains the primary label when the printer later goes offline', () => {
  const status = {
    config: { enabled: true },
    online: false,
    stale: true,
    lastSuccessfulAt: new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString(),
    expectedOutput: { printerMessageName: 'Expected.job' },
    selectedMessage: 'Actual.job',
    consecutiveFailures: 3,
    lastError: 'timeout'
  };

  assert.equal(statusLabel(status), 'Mismatch / Offline');
  assert.equal(statusTone(status), 'offline');
});

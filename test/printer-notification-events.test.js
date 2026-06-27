import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrinterNotificationEvents } from '../server/notifications/printer-events.js';
import { decodeStatus } from '../server/wsi-status.js';

function service(overrides = {}) {
  const offline = [];
  const faults = [];
  const logs = [];
  const events = createPrinterNotificationEvents({
    readPrinters: async () => [{ id: 'coder-1', name: 'Can Coder' }],
    notifyPrinterOffline: async (payload) => {
      offline.push(payload);
      return [{ status: 'sent' }];
    },
    notifyPrinterFault: async (payload) => {
      faults.push(payload);
      return [{ status: 'sent' }];
    },
    addLog: (entry) => logs.push(entry),
    ...overrides
  });
  return { events, faults, logs, offline };
}

test('offline notification is sent only for confirmed offline transitions', async () => {
  const { events, offline } = service();
  const status = {
    printerId: 'coder-1',
    lastSuccessfulAt: '2026-06-27T01:00:00.000Z',
    lastAttemptAt: '2026-06-27T01:01:00.000Z',
    lastError: 'connect ETIMEDOUT'
  };

  await events.handleStatusTransition('offline -> online', status);
  assert.equal(offline.length, 0);

  await events.handleStatusTransition('online -> offline', status);
  assert.equal(offline.length, 1);
  assert.equal(offline[0].printer.name, 'Can Coder');
  assert.equal(offline[0].printerId, 'coder-1');
  assert.equal(offline[0].targetType, 'printer');
  assert.equal(offline[0].targetId, 'coder-1');
  assert.equal(offline[0].errorMessage, 'connect ETIMEDOUT');
});

test('fault notification is sent once for activated fault events', async () => {
  const { events, faults } = service();
  const status = {
    printerId: 'coder-1',
    rawStatus: '1000004',
    decodedStatus: decodeStatus('1000004')
  };

  await events.handleFaultEvents(status, [
    {
      event: 'activated',
      faultCode: 'CHARGE_ERROR',
      faultLabel: 'Charge error',
      occurredAt: '2026-06-27T01:02:00.000Z'
    },
    {
      event: 'cleared',
      faultCode: 'GUTTER_FAULT',
      faultLabel: 'Gutter fault',
      occurredAt: '2026-06-27T01:02:00.000Z'
    }
  ]);

  assert.equal(faults.length, 1);
  assert.equal(faults[0].printer.name, 'Can Coder');
  assert.equal(faults[0].printerId, 'coder-1');
  assert.equal(faults[0].status, 'Red');
  assert.deepEqual(faults[0].faults, ['Charge error']);
  assert.equal(faults[0].detectedAt, '2026-06-27T01:02:00.000Z');
  assert.equal(faults[0].targetType, 'printer');
  assert.equal(faults[0].targetId, 'coder-1');
});

test('fault clears do not send fault notifications', async () => {
  const { events, faults } = service();

  await events.handleFaultEvents({ printerId: 'coder-1', decodedStatus: decodeStatus('0000001') }, [
    {
      event: 'cleared',
      faultCode: 'CHARGE_ERROR',
      faultLabel: 'Charge error',
      occurredAt: '2026-06-27T01:03:00.000Z'
    }
  ]);

  assert.equal(faults.length, 0);
});

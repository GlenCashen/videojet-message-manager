import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FaultHistoryStore, createFaultHistoryStore } from '../server/fault-history-store.js';
import { decodeStatus } from '../server/wsi-status.js';

function status(rawStatus) {
  return {
    printerId: 'coder-1',
    rawStatus,
    decodedStatus: decodeStatus(rawStatus)
  };
}

function sequenceNow(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test('records activation once and clear once with duration', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fault-history-'));
  const filePath = path.join(dir, 'fault-history.json');
  const store = new FaultHistoryStore({
    filePath,
    now: sequenceNow([
      '2026-06-18T04:31:02.000Z',
      '2026-06-18T04:32:02.000Z',
      '2026-06-18T04:34:18.000Z'
    ])
  });
  await store.load();

  const activated = await store.recordStatus(status('4000004'));
  assert.equal(activated.length, 1);
  assert.equal(activated[0].event, 'activated');
  assert.equal(activated[0].faultCode, 'GUTTER_FAULT');

  assert.deepEqual(await store.recordStatus(status('4000004')), []);

  const cleared = await store.recordStatus(status('0000001'));
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].event, 'cleared');
  assert.equal(cleared[0].durationMs, 196000);
  assert.equal(store.query({ printerId: 'coder-1' }).history.length, 2);
});

test('tracks multiple faults independently and reloads persisted history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fault-history-'));
  const filePath = path.join(dir, 'fault-history.json');
  const store = new FaultHistoryStore({
    filePath,
    now: sequenceNow([
      '2026-06-18T04:31:02.000Z',
      '2026-06-18T04:34:18.000Z'
    ])
  });
  await store.load();

  const activated = await store.recordStatus(status('5100006'));
  assert.deepEqual(activated.map((event) => event.faultCode), [
    'CHARGE_ERROR',
    'GUTTER_FAULT',
    'PUMP_FAULT'
  ]);
  assert.equal(store.query({ printerId: 'coder-1', activeOnly: true }).activeFaults.length, 3);

  const cleared = await store.recordStatus(status('0000001'));
  assert.deepEqual(cleared.map((event) => event.faultCode), [
    'CHARGE_ERROR',
    'GUTTER_FAULT',
    'PUMP_FAULT'
  ]);

  const reloaded = await createFaultHistoryStore({ filePath });
  assert.equal(reloaded.query({ printerId: 'coder-1' }).history.length, 6);
  assert.equal(reloaded.query({ printerId: 'coder-1', activeOnly: true }).activeFaults.length, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Monitor } from '../server/monitor.js';

test('monitor polls enabled coders without clients and skips disabled coders', async () => {
  const polled = [];
  const monitor = new Monitor({
    readPrinters: async () => [
      { id: 'coder-1', enabled: true },
      { id: 'coder-2', enabled: false },
      { id: 'coder-3', enabled: true }
    ],
    pollPrinter: async (printer) => polled.push(printer.id),
    pollIntervalMs: 1000,
    betweenCoderDelayMs: 0,
    delay: async () => {}
  });

  await monitor.loop();
  monitor.stop();
  assert.deepEqual(polled, ['coder-1', 'coder-3']);
});

test('one printer failure does not stop the rest of the fleet cycle', async () => {
  const polled = [];
  const errors = [];
  const monitor = new Monitor({
    readPrinters: async () => [
      { id: 'coder-1', enabled: true },
      { id: 'coder-2', enabled: true },
      { id: 'coder-3', enabled: true }
    ],
    pollPrinter: async (printer) => {
      polled.push(printer.id);
      if (printer.id === 'coder-2') throw new Error('connection refused');
    },
    pollIntervalMs: 1000,
    betweenCoderDelayMs: 0,
    delay: async () => {},
    onError: (error, printer) => errors.push({ message: error.message, printerId: printer?.id || null })
  });

  await monitor.loop();
  monitor.stop();

  assert.deepEqual(polled, ['coder-1', 'coder-2', 'coder-3']);
  assert.deepEqual(errors, [{ message: 'connection refused', printerId: 'coder-2' }]);
});

test('offline printers continue to be retried and recover on a later cycle', async () => {
  let reachable = false;
  let attempts = 0;
  let recoveries = 0;

  const monitor = new Monitor({
    readPrinters: async () => [{ id: 'coder-1', enabled: true }],
    pollPrinter: async () => {
      attempts += 1;
      if (!reachable) throw new Error('timeout');
      recoveries += 1;
    },
    pollIntervalMs: 1000,
    betweenCoderDelayMs: 0,
    delay: async () => {},
    onError: () => {}
  });

  await monitor.loop();
  reachable = true;
  await monitor.loop();
  monitor.stop();

  assert.equal(attempts, 2);
  assert.equal(recoveries, 1);
});

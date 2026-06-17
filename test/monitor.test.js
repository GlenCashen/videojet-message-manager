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

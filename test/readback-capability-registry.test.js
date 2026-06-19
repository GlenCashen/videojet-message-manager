import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadbackCapabilityRegistry } from '../server/readback-capability-registry.js';

const printer = { id: 'coder-1', model: '1710', readbackMode: 'auto' };

test('auto-detects and caches 1710 current-message readback support', () => {
  let now = Date.parse('2026-06-19T00:00:00.000Z');
  const registry = new ReadbackCapabilityRegistry({ retryAfterMs: 1000, now: () => now });

  assert.equal(registry.resolve(printer).currentMessageReadback, null);
  assert.equal(registry.shouldProbe(printer), true);

  registry.record(printer.id, false, new Error('Q rejected'));
  assert.equal(registry.resolve(printer).currentMessageReadback, false);
  assert.equal(registry.shouldProbe(printer), false);

  now += 1001;
  assert.equal(registry.shouldProbe(printer), true);
  registry.record(printer.id, true);
  assert.equal(registry.resolve(printer).currentMessageReadback, true);
  assert.equal(registry.shouldProbe(printer), true);
});

test('explicit readback overrides bypass 1710 detection', () => {
  const registry = new ReadbackCapabilityRegistry();
  assert.equal(registry.resolve({ ...printer, readbackMode: 'enabled' }).currentMessageReadback, true);
  assert.equal(registry.resolve({ ...printer, readbackMode: 'disabled' }).currentMessageReadback, false);
  assert.equal(registry.shouldProbe({ ...printer, readbackMode: 'enabled' }), false);
});

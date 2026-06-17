import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeStatus } from '../server/wsi-status.js';

test('decodes traffic-light statuses', () => {
  assert.equal(decodeStatus('0000001').alarm.label, 'Green');
  assert.equal(decodeStatus('0000002').alarm.label, 'Amber');
  assert.equal(decodeStatus('0000004').alarm.label, 'Red');
});

test('decodes combined fault bits independently', () => {
  const decoded = decodeStatus('4100004');
  assert.equal(decoded.valid, true);
  assert.deepEqual(decoded.faults.map((fault) => fault.code), ['GUTTER_FAULT', 'PUMP_FAULT']);
  assert.equal(decoded.alarm.red, true);
});

test('decodes combined alarms and normalizes lowercase', () => {
  const decoded = decodeStatus('3000004'.toLowerCase());
  assert.deepEqual(decoded.faults.map((fault) => fault.code), ['CHARGE_ERROR', 'EHT_TRIP']);
  assert.equal(decoded.raw, '3000004');
});

test('rejects invalid status values safely', () => {
  assert.equal(decodeStatus('BAD').valid, false);
  assert.equal(decodeStatus('000000Z').valid, false);
});

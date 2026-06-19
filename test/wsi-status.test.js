import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeStatus, encodeStatus } from '../server/wsi-status.js';

test('decodes traffic-light statuses without faults', () => {
  assert.equal(decodeStatus('0000001').alarm.label, 'Green');
  assert.equal(decodeStatus('0000001').hasFaults, false);
  assert.equal(decodeStatus('0000002').alarm.label, 'Amber');
  assert.equal(decodeStatus('0000004').alarm.label, 'Red');
});

test('decodes gutter fault and red status', () => {
  const decoded = decodeStatus('4000004');
  assert.equal(decoded.valid, true);
  assert.deepEqual(decoded.activeFaults.map((fault) => fault.code), ['GUTTER_FAULT']);
  assert.equal(decoded.activeFaults[0].byte, 1);
  assert.equal(decoded.activeFaults[0].bit, 4);
  assert.equal(decoded.alarm.primary, 'red');
});

test('decodes combined faults and alarms', () => {
  const decoded = decodeStatus('5100006');
  assert.deepEqual(decoded.activeFaults.map((fault) => fault.code), [
    'CHARGE_ERROR',
    'GUTTER_FAULT',
    'PUMP_FAULT'
  ]);
  assert.equal(decoded.alarm.amber, true);
  assert.equal(decoded.alarm.red, true);
  assert.equal(decoded.alarm.primary, 'red');
  assert.equal(decoded.alarm.label, 'Red');
});

test('decodes combined bits in every fault byte', () => {
  const decoded = decodeStatus('FFFFFFF');
  assert.equal(decoded.activeFaults.length, 24);
  assert.deepEqual(decoded.activeFaults.slice(0, 4).map((fault) => fault.code), [
    'CHARGE_ERROR',
    'EHT_TRIP',
    'GUTTER_FAULT',
    'INK_CORE_EMPTY'
  ]);
  assert.deepEqual(decoded.activeFaults.slice(-4).map((fault) => fault.code), [
    'DATE_TIME_NOT_SET',
    'INK_REFERENCE_MISMATCH',
    'EHT_CALIBRATION_REQUIRED',
    'RESERVED_FAULT_BIT'
  ]);
});

test('rejects malformed status values safely', () => {
  for (const value of ['000001', '00000001', 'ZZ00001', '']) {
    const decoded = decodeStatus(value);
    assert.equal(decoded.valid, false);
    assert.equal(decoded.error, 'Invalid WSI status response');
    assert.deepEqual(decoded.activeFaults, []);
    assert.equal(decoded.alarm, null);
    assert.equal(decoded.hasFaults, false);
  }
});

test('encodes named emulator faults into the WSI status mask', () => {
  const raw = encodeStatus({
    faultCodes: ['GUTTER_FAULT', 'PUMP_FAULT', 'DATE_TIME_NOT_SET'],
    alarm: 'red'
  });
  assert.equal(raw, '4100014');
  assert.deepEqual(decodeStatus(raw).activeFaults.map((fault) => fault.code), [
    'GUTTER_FAULT',
    'PUMP_FAULT',
    'DATE_TIME_NOT_SET'
  ]);
  assert.equal(decodeStatus(raw).alarm.primary, 'red');
});

test('rejects unknown emulator fault and alarm names', () => {
  assert.throws(() => encodeStatus({ faultCodes: ['NOT_A_FAULT'] }), /Unknown fault code/);
  assert.throws(() => encodeStatus({ alarm: 'purple' }), /Unknown alarm state/);
});

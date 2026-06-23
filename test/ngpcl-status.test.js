import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeNgpclStatus } from '../server/ngpcl-status.js';

test('decodes confirmed NGPCL traffic-light states', () => {
  assert.equal(decodeNgpclStatus('{~DS0|0|1|0|0|0|2|0|000000000|06|1|}').alarm.primary, 'green');
  assert.equal(decodeNgpclStatus('{~DS0|0|0|0|0|0|2|0|000000000|11|1|}').operatorStatus, 'Idle');
  assert.equal(decodeNgpclStatus('{~DS0|0|0|0|1|0|2|0|000000000|05|1|}').alarm.primary, 'yellow');
  assert.equal(decodeNgpclStatus('{~DS0|0|0|1|1|0|2|0|000000000|09|1|}').alarm.primary, 'blue');
  assert.equal(decodeNgpclStatus('{~DS0|0|0|0|0|0|2|0|000000000|02|1|}').operatorStatus, 'Off');
  assert.equal(decodeNgpclStatus('{~DS0|0|0|0|0|0|2|0|000000000|04|1|}').operatorStatus, 'Stopped');
});

test('rejects malformed NGPCL status safely', () => {
  const decoded = decodeNgpclStatus('{~NK1|}');
  assert.equal(decoded.valid, false);
  assert.equal(decoded.error, 'Invalid NGPCL status response');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPacketResponse,
  commandChecksum,
  commandRejectedError,
  responseDetails
} from '../server/wsi-response.js';

test('WSI ! suffix is interpreted as the command checksum, not an error number', () => {
  assert.equal(commandChecksum('Q'), '51');
  const response = { kind: 'nack', value: '!51', hex: '21 35 31' };
  assert.deepEqual(responseDetails('Q', response), {
    command: 'Q',
    commandName: 'Request Current Selected Message',
    rawCode: '!51',
    rawResponseHex: '21 35 31',
    responseChecksum: '51',
    expectedChecksum: '51',
    checksumMatches: true
  });

  const error = commandRejectedError('Q', response);
  assert.equal(error.reasonCode, 'WSI_COMMAND_REJECTED');
  assert.match(error.message, /not an error number/i);
  assert.match(error.message, /unknown or failed command/i);
});

test('packet requests throw a protocol error for ! responses', () => {
  assert.throws(
    () => assertPacketResponse('E', { kind: 'nack', value: '!45', hex: '21 34 35' }),
    (error) => error.code === 'WSI_PROTOCOL_ERROR' && error.command === 'E' && error.checksumMatches
  );
});

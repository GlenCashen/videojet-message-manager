import assert from 'node:assert/strict';
import test from 'node:test';
import { requestCurrentMessage } from '../server/current-message.js';

test('current-message readback normalizes a packet response', async () => {
  const client = {
    sendCommand: async (request) => {
      assert.equal(request.command, 'Q');
      return { kind: 'packet', value: '9 MONTH', hex: '02 39 20 4D 4F 4E 54 48 03' };
    }
  };

  assert.deepEqual(await requestCurrentMessage(client, { printerId: 'coder-1', ip: '127.0.0.1', port: 3100 }), {
    currentMessage: '9 MONTH',
    rawCode: null,
    rawResponseHex: '02 39 20 4D 4F 4E 54 48 03'
  });
});

test('current-message readback exposes a printer rejection safely', async () => {
  const client = {
    sendCommand: async () => ({ kind: 'nack', value: '!51', hex: '21 35 31' })
  };

  await assert.rejects(
    requestCurrentMessage(client, { printerId: 'coder-1', ip: '127.0.0.1', port: 3100 }),
    (error) => error.code === 'WSI_PROTOCOL_ERROR' && error.rawCode === '!51' && error.rawResponseHex === '21 35 31'
  );
});

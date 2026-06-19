import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { EmulatorManager } from '../server/emulator-manager.js';
import { WsiClient } from '../server/wsi-client.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('each configured emulator has isolated state and its own listener', async (t) => {
  const firstPort = await freePort();
  const secondPort = await freePort();
  const printers = [
    { id: 'coder-a', name: 'Coder A', mode: 'emulator', port: firstPort },
    { id: 'coder-b', name: 'Coder B', mode: 'emulator', port: secondPort }
  ];
  const manager = new EmulatorManager();
  t.after(() => manager.close());
  await manager.sync(printers);
  manager.configurePrinter('coder-a', { messageNames: ['TBUNDRC'], fieldNames: ['RUN'] });
  manager.update('coder-a', { selectedMessage: '12 MONTH', faultCodes: ['GUTTER_FAULT'], alarm: 'red' });

  assert.equal(manager.snapshot('coder-a').selectedMessage, '12 MONTH');
  assert.equal(manager.snapshot('coder-a').status, '4000004');
  assert.equal(manager.snapshot('coder-b').selectedMessage, '9 MONTH');
  assert.equal(manager.snapshot('coder-b').status, '0000002');

  const client = new WsiClient({ timeoutMs: 1000 });
  const first = await client.sendCommand({ printerId: 'coder-a', ip: '127.0.0.1', port: firstPort, command: 'Q' });
  const second = await client.sendCommand({ printerId: 'coder-b', ip: '127.0.0.1', port: secondPort, command: 'Q' });
  assert.equal(first.value, '12 MONTH');
  assert.equal(second.value, '9 MONTH');
  assert.equal((await client.sendCommand({ printerId: 'coder-a', ip: '127.0.0.1', port: firstPort, command: 'URUN\nT0050' })).kind, 'ack');
  assert.equal((await client.sendCommand({ printerId: 'coder-a', ip: '127.0.0.1', port: firstPort, command: 'MTBUNDRC' })).kind, 'ack');
  assert.equal(manager.snapshot('coder-a').selectedMessage, 'TBUNDRC');
});

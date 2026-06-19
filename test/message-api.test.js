import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child, output = []) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}.\n${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Server did not start.');
}

test('preview endpoint does not issue WSI commands', async () => {
  const port = await freePort();
  const emulatorPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      POLL_INTERVAL_MS: '0',
      EMULATOR_PORT: String(emulatorPort),
      DB_PATH: path.join(tmpdir(), `vmm-message-api-${port}.db`),
      ENABLE_DEV_IDENTITY: 'true',
      DEV_USER_ROLE: 'engineering'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);
    await fetch(`${baseUrl}/api/debug/wsi-counters/reset`, { method: 'POST' });
    const response = await fetch(`${baseUrl}/api/messages/12-month/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: { brew: 'BR1246', batch: 'B260617A' },
        productionDate: '2026-06-17T14:32:08+10:00'
      })
    });
    assert.equal(response.ok, true);
    const preview = await response.json();
    assert.equal(preview.rendered, 'BR1246 B260617A\nBBD: 17/06/2027 14:32:08');

    const countersResponse = await fetch(`${baseUrl}/api/debug/wsi-counters`);
    assert.deepEqual(await countersResponse.json(), {});
  } finally {
    const exitPromise = child.exitCode === null
      ? new Promise((resolve) => child.once('exit', resolve))
      : Promise.resolve();
    child.kill();
    await exitPromise;
    if (child.exitCode && child.exitCode !== 0 && child.exitCode !== 1) {
      throw new Error(output.join(''));
    }
  }
});

test('fault history API records activation and clear from emulator checks', async () => {
  const port = await freePort();
  const emulatorPort = await freePort();
  const dir = await mkdtemp(path.join(tmpdir(), 'fault-api-'));
  const faultHistoryPath = path.join(dir, 'fault-history.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      POLL_INTERVAL_MS: '0',
      EMULATOR_PORT: String(emulatorPort),
      DB_PATH: path.join(tmpdir(), `vmm-message-api-${port}.db`),
      ENABLE_DEV_IDENTITY: 'true',
      DEV_USER_ROLE: 'engineering',
      FAULT_HISTORY_LIMIT: '20',
      FAULT_HISTORY_PATH: faultHistoryPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  async function waitForHistory(expectedCount) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/printers/coder-2/faults?limit=20`);
      const data = await response.json();
      if (data.history.length >= expectedCount) return data;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Fault history did not reach ${expectedCount} events.`);
  }

  try {
    await waitForServer(baseUrl, child, output);
    await fetch(`${baseUrl}/api/emulator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: '4000004' })
    });
    const check = await fetch(`${baseUrl}/api/printers/coder-2/check`, { method: 'POST' });
    const checkResult = await check.json();
    assert.equal(check.ok, true, JSON.stringify(checkResult));

    const activated = await waitForHistory(1);
    assert.equal(activated.activeFaults.length, 1);
    assert.equal(activated.activeFaults[0].faultCode, 'GUTTER_FAULT');
    assert.equal(activated.history[0].event, 'activated');

    await fetch(`${baseUrl}/api/emulator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: '0000001' })
    });
    const clearCheck = await fetch(`${baseUrl}/api/printers/coder-2/check`, { method: 'POST' });
    assert.equal(clearCheck.ok, true);

    const cleared = await waitForHistory(2);
    assert.equal(cleared.activeFaults.length, 0);
    assert.equal(cleared.history[0].event, 'cleared');
    assert.equal(cleared.history[0].faultCode, 'GUTTER_FAULT');

    const activeOnly = await fetch(`${baseUrl}/api/printers/coder-2/faults?active=true`);
    const activeOnlyData = await activeOnly.json();
    assert.deepEqual(activeOnlyData.history, []);

    const badLimit = await fetch(`${baseUrl}/api/printers/coder-2/faults?limit=999`);
    assert.equal(badLimit.status, 400);

    const unknown = await fetch(`${baseUrl}/api/printers/missing/faults`);
    assert.equal(unknown.status, 404);
  } finally {
    const exitPromise = child.exitCode === null
      ? new Promise((resolve) => child.once('exit', resolve))
      : Promise.resolve();
    child.kill();
    await exitPromise;
    if (child.exitCode && child.exitCode !== 0 && child.exitCode !== 1) {
      throw new Error(output.join(''));
    }
  }
});

test('current-message endpoint tracks emulator selection and reports rejection safely', async () => {
  const port = await freePort();
  const emulatorPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      POLL_INTERVAL_MS: '0',
      EMULATOR_PORT: String(emulatorPort),
      DB_PATH: path.join(tmpdir(), `vmm-current-message-${port}.db`),
      ENABLE_DEV_IDENTITY: 'true',
      DEV_USER_ROLE: 'engineering'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);

    const initialResponse = await fetch(`${baseUrl}/api/printer/current-message`);
    assert.equal(initialResponse.ok, true);
    const initial = await initialResponse.json();
    assert.equal(initial.currentMessage, '9 MONTH');
    assert.equal(initial.printer, `127.0.0.1:${emulatorPort}`);
    assert.match(initial.rawResponseHex, /^02 /);

    const setResponse = await fetch(`${baseUrl}/api/printers/coder-1/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId: '12-month',
        fields: { brew: 'BR1246', batch: 'B260617A' }
      })
    });
    const setResult = await setResponse.json();
    assert.equal(setResponse.ok, true, JSON.stringify(setResult));

    const changedResponse = await fetch(`${baseUrl}/api/printer/current-message?printerId=coder-1`);
    assert.equal(changedResponse.ok, true);
    assert.equal((await changedResponse.json()).currentMessage, '12 MONTH');

    await fetch(`${baseUrl}/api/emulator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failNextCommand: true })
    });
    const failedResponse = await fetch(`${baseUrl}/api/printer/current-message?printerId=coder-1`);
    assert.equal(failedResponse.status, 502);
    const failed = await failedResponse.json();
    assert.equal(failed.ok, false);
    assert.equal(failed.rawCode, '!51');
    assert.equal(failed.rawResponseHex, '21 35 31');
    assert.equal(failed.command, 'Q');
    assert.equal(failed.responseChecksum, '51');
    assert.equal(failed.expectedChecksum, '51');
    assert.equal(failed.checksumMatches, true);
    assert.match(failed.error, /rejected/i);
    assert.match(failed.error, /not an error number/i);

    const recoveredResponse = await fetch(`${baseUrl}/api/printer/current-message?printerId=coder-1`);
    assert.equal(recoveredResponse.ok, true);
    assert.equal((await recoveredResponse.json()).currentMessage, '12 MONTH');
  } finally {
    const exitPromise = child.exitCode === null
      ? new Promise((resolve) => child.once('exit', resolve))
      : Promise.resolve();
    child.kill();
    await exitPromise;
    if (child.exitCode && child.exitCode !== 0 && child.exitCode !== 1) {
      throw new Error(output.join(''));
    }
  }
});

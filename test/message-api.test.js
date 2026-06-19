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

async function freePortBlock(size = 3) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const base = 35000 + Math.floor(Math.random() * 12000);
    const servers = [];
    try {
      for (let offset = 0; offset < size; offset += 1) {
        const server = net.createServer();
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(base + offset, '127.0.0.1', resolve);
        });
        servers.push(server);
      }
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      return base;
    } catch (_error) {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    }
  }
  throw new Error('Unable to reserve a contiguous emulator port block.');
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
  const emulatorPort = await freePortBlock();
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

test('legacy message jobs cannot be created or sent', async () => {
  const port = await freePort();
  const emulatorPort = await freePortBlock();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      POLL_INTERVAL_MS: '0',
      EMULATOR_PORT: String(emulatorPort),
      DB_PATH: path.join(tmpdir(), `vmm-message-jobs-${port}.db`),
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
    const createResponse = await fetch(`${baseUrl}/api/message-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId: '12-month',
        printerIds: ['coder-1', 'coder-2'],
        fields: { brew: 'BR1246', batch: 'B260617A' },
        productionDate: '2026-06-17T14:32:08+10:00',
        expiresHours: 8
      })
    });
    assert.equal(createResponse.status, 410);
    const created = await createResponse.json();
    assert.match(created.error, /controlled production releases/i);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/debug/wsi-counters`)).json(), {});
    return;
    assert.equal(created.job.status, 'pending');
    assert.equal(created.job.targets.length, 2);
    assert.equal(created.job.targets[0].preview.rendered, 'BR1246 B260617A\nBBD: 17/06/2027 14:32:08');
    assert.deepEqual(await (await fetch(`${baseUrl}/api/debug/wsi-counters`)).json(), {});

    const acceptResponse = await fetch(`${baseUrl}/api/message-jobs/${created.job.id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerIds: ['coder-1'] })
    });
    const accepted = await acceptResponse.json();
    assert.equal(acceptResponse.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.job.targets.find((target) => target.printerId === 'coder-1').status, 'succeeded');
    assert.equal(accepted.job.targets.find((target) => target.printerId === 'coder-2').status, 'pending');
    assert.equal((await (await fetch(`${baseUrl}/api/printer/current-message?printerId=coder-1`)).json()).currentMessage, '12 MONTH');

    const declineResponse = await fetch(`${baseUrl}/api/message-jobs/${created.job.id}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerIds: ['coder-2'], reason: 'Wrong production line' })
    });
    assert.equal(declineResponse.ok, true);
    const declined = await declineResponse.json();
    assert.equal(declined.job.status, 'completed');
    assert.equal(declined.job.targets.find((target) => target.printerId === 'coder-2').status, 'declined');

    const listed = await (await fetch(`${baseUrl}/api/message-jobs`)).json();
    assert.equal(listed[0].id, created.job.id);
  } finally {
    const exitPromise = child.exitCode === null
      ? new Promise((resolve) => child.once('exit', resolve))
      : Promise.resolve();
    child.kill();
    await exitPromise;
    if (child.exitCode && child.exitCode !== 0 && child.exitCode !== 1) throw new Error(output.join(''));
  }
});

test('fault history API records activation and clear from emulator checks', async () => {
  const port = await freePort();
  const emulatorPort = await freePortBlock();
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
    const configuredResponse = await fetch(`${baseUrl}/api/emulator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: 'coder-2', faultCodes: ['GUTTER_FAULT'], alarm: 'red' })
    });
    const configured = await configuredResponse.json();
    assert.equal(configured.status, '4000004');
    assert.deepEqual(configured.activeFaultCodes, ['GUTTER_FAULT']);
    assert.equal(configured.alarm, 'red');
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
      body: JSON.stringify({ printerId: 'coder-2', faultCodes: [], alarm: 'green' })
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
  const emulatorPort = await freePortBlock();
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

    const modelResponse = await fetch(`${baseUrl}/api/printers/coder-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '1710' })
    });
    assert.equal(modelResponse.ok, true);
    assert.equal((await modelResponse.json()).printer.capabilities.currentMessageReadback, null);

    await fetch(`${baseUrl}/api/debug/wsi-counters/reset`, { method: 'POST' });
    await fetch(`${baseUrl}/api/emulator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failNextCommand: true })
    });
    const probeFailureCheck = await fetch(`${baseUrl}/api/printers/coder-1/check`, { method: 'POST' });
    assert.equal(probeFailureCheck.ok, true);
    const probeFailureResult = await probeFailureCheck.json();
    assert.equal(probeFailureResult.messageVerification, 'unsupported');
    assert.equal(probeFailureResult.capabilities.currentMessageReadback, false);
    let counters = await (await fetch(`${baseUrl}/api/debug/wsi-counters`)).json();
    assert.equal(counters['coder-1'].Q, 1);
    assert.equal(counters['coder-1'].E, 1);

    await fetch(`${baseUrl}/api/debug/wsi-counters/reset`, { method: 'POST' });
    const detectedResponse = await fetch(`${baseUrl}/api/printer/current-message?printerId=coder-1`);
    assert.equal(detectedResponse.ok, true);
    assert.equal((await detectedResponse.json()).currentMessage, '12 MONTH');

    const checkResponse = await fetch(`${baseUrl}/api/printers/coder-1/check`, { method: 'POST' });
    assert.equal(checkResponse.ok, true);
    const checkResult = await checkResponse.json();
    assert.equal(checkResult.messageVerification, 'verified');
    assert.equal(checkResult.capabilities.currentMessageReadback, true);

    counters = await (await fetch(`${baseUrl}/api/debug/wsi-counters`)).json();
    assert.equal(counters['coder-1'].Q, 2);
    assert.equal(counters['coder-1'].E, 1);

    const disabledResponse = await fetch(`${baseUrl}/api/printers/coder-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readbackMode: 'disabled' })
    });
    assert.equal(disabledResponse.ok, true);
    assert.equal((await disabledResponse.json()).printer.capabilities.currentMessageReadback, false);

    await fetch(`${baseUrl}/api/debug/wsi-counters/reset`, { method: 'POST' });
    const unsupportedResponse = await fetch(`${baseUrl}/api/printer/current-message?printerId=coder-1`);
    assert.equal(unsupportedResponse.status, 409);
    assert.equal((await unsupportedResponse.json()).reasonCode, 'CURRENT_MESSAGE_READBACK_UNSUPPORTED');
    assert.equal((await fetch(`${baseUrl}/api/printers/coder-1/check`, { method: 'POST' })).ok, true);
    counters = await (await fetch(`${baseUrl}/api/debug/wsi-counters`)).json();
    assert.equal(counters['coder-1'].Q, 0);
    assert.equal(counters['coder-1'].E, 1);
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

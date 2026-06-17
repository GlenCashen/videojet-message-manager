import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function waitForServer(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}.`);
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
  const port = 18080 + Math.floor(Math.random() * 1000);
  const emulatorPort = 19080 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      POLL_INTERVAL_MS: '0',
      EMULATOR_PORT: String(emulatorPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child);
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
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    if (child.exitCode && child.exitCode !== 0 && child.exitCode !== 1) {
      throw new Error(output.join(''));
    }
  }
});

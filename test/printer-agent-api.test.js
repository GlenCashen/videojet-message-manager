import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output.join(''));
    try {
      if ((await fetch(`${baseUrl}/api/config`)).ok) return;
    } catch (_error) {
      // Startup can briefly refuse connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start.\n${output.join('')}`);
}

test('printer-agent API requires credentials and accepts its configured identity', async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      POLL_INTERVAL_MS: '0',
      DB_PATH: path.join(tmpdir(), `vmm-printer-agent-api-${port}.db`),
      ENABLE_DEV_IDENTITY: 'true',
      PRINTER_EXECUTION_MODE: 'agent',
      PRINTER_AGENT_ID: 'line-agent',
      PRINTER_AGENT_TOKEN: 'test-secret',
      PRINTER_AGENT_PRINTER_IDS: 'coder-1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);
    const unauthorized = await fetch(`${baseUrl}/api/printer-agent/v1/jobs/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(unauthorized.status, 401);

    const headers = {
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json',
      'X-Printer-Agent-Id': 'line-agent'
    };
    const heartbeat = await fetch(`${baseUrl}/api/printer-agent/v1/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 'test',
        hostname: 'test-host',
        statuses: [
          { printerId: 'coder-1', online: true, selectedMessage: 'TEST MESSAGE', messageVerification: 'verified', rawStatus: '0000001', responseTimeMs: 12 },
          { printerId: 'coder-2', online: true, selectedMessage: 'NOT ALLOWED', messageVerification: 'verified', rawStatus: '0000001', responseTimeMs: 12 }
        ]
      })
    });
    assert.equal(heartbeat.status, 200);
    assert.equal((await heartbeat.json()).executionMode, 'agent');

    const statuses = await fetch(`${baseUrl}/api/printers/status`, {
      headers: { Cookie: 'devRole=admin; devPrinterIds=' }
    });
    assert.equal(statuses.status, 200);
    const statusBody = await statuses.json();
    assert.equal(statusBody.find((status) => status.printerId === 'coder-1').selectedMessage, 'TEST MESSAGE');
    assert.notEqual(statusBody.find((status) => status.printerId === 'coder-2')?.selectedMessage, 'NOT ALLOWED');

    const emptyClaim = await fetch(`${baseUrl}/api/printer-agent/v1/jobs/claim`, {
      method: 'POST',
      headers,
      body: '{}'
    });
    assert.equal(emptyClaim.status, 204);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

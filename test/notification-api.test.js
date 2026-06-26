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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output.join(''));
    try {
      if ((await fetch(`${baseUrl}/api/config`)).ok) return;
    } catch (_error) {
      // Server startup can briefly refuse connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start.');
}

async function jsonFetch(url, { method = 'GET', body, role = 'admin' } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Cookie: `devRole=${role}; devPrinterIds=`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json() };
}

test('admin can manage notification lists', async () => {
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
      DB_PATH: path.join(tmpdir(), `vmm-notification-api-${port}.db`),
      ENABLE_DEV_IDENTITY: 'true',
      DEV_USER_ROLE: 'admin'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);

    const initial = await jsonFetch(`${baseUrl}/api/notification-lists`);
    assert.equal(initial.response.status, 200);
    assert.ok(initial.data.some((list) => list.id === 'release-reviewers'));

    const invalid = await jsonFetch(`${baseUrl}/api/notification-lists`, {
      method: 'POST',
      body: {
        name: 'Broken list',
        eventKey: 'release.pending_review',
        recipientEmails: ['not-an-email']
      }
    });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.data.error, /invalid notification email/i);

    const created = await jsonFetch(`${baseUrl}/api/notification-lists`, {
      method: 'POST',
      body: {
        name: 'Shift leads',
        description: 'Line escalation inboxes',
        eventKey: 'printer.offline',
        enabled: true,
        recipientRoles: ['engineering'],
        recipientUserIds: [],
        recipientEmails: ['Leads@Example.Test']
      }
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.list.name, 'Shift leads');
    assert.deepEqual(created.data.list.recipientEmails, ['leads@example.test']);

    const updated = await jsonFetch(`${baseUrl}/api/notification-lists/${created.data.list.id}`, {
      method: 'PUT',
      body: {
        name: 'Shift leads updated',
        eventKey: 'printer.fault',
        enabled: false,
        recipientRoles: ['qa', 'nope'],
        recipientUserIds: ['user-1'],
        recipientEmails: ['qa@example.test']
      }
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.list.enabled, false);
    assert.deepEqual(updated.data.list.recipientRoles, ['qa']);

    const deleted = await jsonFetch(`${baseUrl}/api/notification-lists/${created.data.list.id}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    const after = await jsonFetch(`${baseUrl}/api/notification-lists`);
    assert.equal(after.data.some((list) => list.id === created.data.list.id), false);
  } finally {
    child.kill();
  }
});

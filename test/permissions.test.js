import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canAccessDiagnostics,
  canConfigurePrinters,
  canEditMessages,
  canManageUsers,
  canOperatePrinter,
  canViewEditor,
  canViewPrinter,
  developmentUser,
  getCapabilities,
  visiblePrinters
} from '../server/permissions.js';

const TEST_PRINTERS = [
  { id: 'coder-1', name: 'Can Coder' },
  { id: 'coder-2', name: 'Bottle Coder' },
  { id: 'coder-3', name: 'Case Coder' }
];

function randomPort(base = 18180) {
  return base + Math.floor(Math.random() * 1000);
}

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

function startServer({ role, printerIds = '', extraEnv = {} }) {
  const port = randomPort();
  const emulatorPort = randomPort(19180);
  const dbPath = extraEnv.DB_PATH || path.join(tmpdir(), `vmm-permissions-${port}.db`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      POLL_INTERVAL_MS: '0',
      EMULATOR_PORT: String(emulatorPort),
      DB_PATH: dbPath,
      ENABLE_DEV_IDENTITY: 'true',
      DEV_USER_ROLE: role,
      DEV_USER_PRINTER_IDS: printerIds,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  return { baseUrl, child, output };
}

async function tempDbPath(prefix = 'vmm-db-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, 'videojet.db');
}

async function withServer(options, run) {
  const server = startServer(options);
  try {
    await waitForServer(server.baseUrl, server.child);
    await run(server.baseUrl);
  } finally {
    server.child.kill();
    await new Promise((resolve) => server.child.once('exit', resolve));
    if (server.child.exitCode && server.child.exitCode !== 0 && server.child.exitCode !== 1) {
      throw new Error(server.output.join(''));
    }
  }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }
  return { response, data };
}

async function readSseEvents(url, wantedType, limit = 10) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.ok, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';

  try {
    while (events.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(6));
        events.push(event);
        if (event.type === wantedType) return event;
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  throw new Error(`SSE event ${wantedType} was not received.`);
}

test('permission helpers expose role capabilities centrally', () => {
  const viewer = developmentUser({ role: 'viewer' });
  const operator = developmentUser({ role: 'operator', printerIds: ['coder-1'] });
  const devWildcardOperator = developmentUser({ role: 'operator', printerIds: ['*'] });
  const productionWildcardOperator = { roles: ['operator'], printerIds: ['*'] };
  const qa = developmentUser({ role: 'qa' });
  const engineering = developmentUser({ role: 'engineering' });
  const admin = developmentUser({ role: 'admin' });

  assert.equal(canViewEditor(viewer), false);
  assert.equal(canViewPrinter(viewer, 'coder-2'), true);
  assert.equal(canOperatePrinter(viewer, 'coder-1'), false);

  assert.deepEqual(visiblePrinters(operator, TEST_PRINTERS).map((printer) => printer.id), ['coder-1']);
  assert.equal(canOperatePrinter(operator, 'coder-1'), true);
  assert.equal(canOperatePrinter(operator, 'coder-2'), false);
  assert.deepEqual(visiblePrinters(devWildcardOperator, TEST_PRINTERS).map((printer) => printer.id), ['coder-1', 'coder-2', 'coder-3']);
  assert.deepEqual(visiblePrinters(productionWildcardOperator, TEST_PRINTERS), []);

  assert.equal(canEditMessages(qa), true);
  assert.equal(canAccessDiagnostics(qa), false);
  assert.equal(canConfigurePrinters(engineering), true);
  assert.equal(canManageUsers(admin), true);
  assert.equal(getCapabilities(null).viewDashboard, false);
});

test('viewer can read dashboard data but cannot access editor APIs', async () => {
  await withServer({ role: 'viewer' }, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/dashboard`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/editor`)).status, 403);

    const printers = await jsonFetch(`${baseUrl}/api/printers`);
    assert.equal(printers.response.ok, true);
    assert.equal(printers.data.length, 3);

    const messages = await jsonFetch(`${baseUrl}/api/messages`);
    assert.equal(messages.response.status, 403);

    const logs = await jsonFetch(`${baseUrl}/api/logs`);
    assert.equal(logs.response.status, 403);
  });
});

test('operator APIs are filtered to assigned printers', async () => {
  await withServer({ role: 'operator', printerIds: 'coder-2' }, async (baseUrl) => {
    const session = await jsonFetch(`${baseUrl}/api/session`);
    assert.deepEqual(session.data.user.printerIds, ['coder-2']);

    const printers = await jsonFetch(`${baseUrl}/api/printers`);
    assert.deepEqual(printers.data.map((printer) => printer.id), ['coder-2']);

    const statuses = await jsonFetch(`${baseUrl}/api/printers/status`);
    assert.equal(statuses.response.ok, true);
    assert(statuses.data.every((status) => status.printerId === 'coder-2'));

    const deniedDetail = await jsonFetch(`${baseUrl}/api/printers/coder-1/status`);
    assert.equal(deniedDetail.response.status, 403);

    const assignedMessages = await jsonFetch(`${baseUrl}/api/printers/coder-2/messages`);
    assert.equal(assignedMessages.response.ok, true);
    assert(assignedMessages.data.length > 0);

    const unassignedMessages = await jsonFetch(`${baseUrl}/api/printers/coder-1/messages`);
    assert.equal(unassignedMessages.response.status, 403);

    const deniedSet = await jsonFetch(`${baseUrl}/api/printers/coder-1/set`, {
      method: 'POST',
      body: { messageId: '12-month', fields: { brew: 'BR1246', batch: 'B260617A' } }
    });
    assert.equal(deniedSet.response.status, 403);

    const check = await jsonFetch(`${baseUrl}/api/printers/coder-2/check`, { method: 'POST' });
    assert.equal(check.response.ok, true);
  });
});

test('development operator wildcard and switcher validation are explicit', async () => {
  await withServer({ role: 'operator', printerIds: '*' }, async (baseUrl) => {
    const printers = await jsonFetch(`${baseUrl}/api/printers`);
    assert.deepEqual(printers.data.map((printer) => printer.id), ['coder-1', 'coder-2', 'coder-3']);

    const unknown = await jsonFetch(`${baseUrl}/api/dev/session`, {
      method: 'POST',
      body: { role: 'operator', printerIds: ['coder-99'] }
    });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.data.code, 'UNKNOWN_PRINTER');

    const empty = await jsonFetch(`${baseUrl}/api/dev/session`, {
      method: 'POST',
      body: { role: 'operator', printerIds: [] }
    });
    assert.equal(empty.response.ok, true);
    const cookie = empty.response.headers.get('set-cookie');
    assert.match(cookie, /devPrinterIds=coder-1/);
  });
});

test('privileged roles expose editor, audit, diagnostics and admin capabilities', async () => {
  await withServer({ role: 'qa' }, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/editor`)).status, 200);
    assert.equal((await jsonFetch(`${baseUrl}/api/messages`)).response.ok, true);
    assert.equal((await jsonFetch(`${baseUrl}/api/logs`)).response.ok, true);
    assert.equal((await jsonFetch(`${baseUrl}/api/emulator`)).response.status, 403);
  });

  await withServer({ role: 'engineering' }, async (baseUrl) => {
    assert.equal((await jsonFetch(`${baseUrl}/api/emulator`)).response.ok, true);
    const configureAttempt = await jsonFetch(`${baseUrl}/api/printers/missing`, {
      method: 'PUT',
      body: { name: 'Missing', location: '', host: '127.0.0.1', port: 3100, enabled: true, mode: 'emulator' }
    });
    assert.notEqual(configureAttempt.response.status, 403);
  });

  await withServer({ role: 'admin' }, async (baseUrl) => {
    const session = await jsonFetch(`${baseUrl}/api/session`);
    assert.equal(session.data.capabilities.manageUsers, true);
  });
});

test('startup fails without users, bootstrap credentials or development identity', async () => {
  const dbPath = await tempDbPath('vmm-no-users-');
  const server = startServer({ role: 'viewer', extraEnv: { ENABLE_DEV_IDENTITY: 'false', SESSION_SECRET: 'test-secret', DB_PATH: dbPath } });
  await new Promise((resolve) => server.child.once('exit', resolve));
  assert.notEqual(server.child.exitCode, 0);
  assert.match(server.output.join(''), /No users exist/);
});

test('SSE snapshots are filtered by session visibility', async () => {
  await withServer({ role: 'operator', printerIds: 'coder-2' }, async (baseUrl) => {
    const fleet = await readSseEvents(`${baseUrl}/api/events`, 'fleet-snapshot');
    assert.deepEqual(fleet.payload.map((printer) => printer.id), ['coder-2']);
  });

  await withServer({ role: 'engineering' }, async (baseUrl) => {
    const fleet = await readSseEvents(`${baseUrl}/api/events`, 'fleet-snapshot');
    assert.deepEqual(fleet.payload.map((printer) => printer.id), ['coder-1', 'coder-2', 'coder-3']);
  });
});

test('unauthenticated SSE is rejected when real auth is required', async () => {
  const dbPath = await tempDbPath('vmm-bootstrap-sse-');
  await withServer({
    role: 'viewer',
    extraEnv: {
      ENABLE_DEV_IDENTITY: 'false',
      SESSION_SECRET: 'test-secret',
      DB_PATH: dbPath,
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_PASSWORD: 'password123'
    }
  }, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/events`)).status, 401);
  });
});

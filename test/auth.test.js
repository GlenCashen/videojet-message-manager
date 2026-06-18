import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function randomPort(base = 20180) {
  return base + Math.floor(Math.random() * 1000);
}

async function tempDbPath(prefix = 'vmm-auth-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, 'videojet.db');
}

function startServer(extraEnv = {}) {
  const port = randomPort();
  const emulatorPort = randomPort(21180);
  const dbPath = extraEnv.DB_PATH || path.join(tmpdir(), `vmm-auth-${port}.db`);
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
      ENABLE_DEV_IDENTITY: 'false',
      SESSION_SECRET: 'test-session-secret',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  return { baseUrl, child, output };
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

async function withServer(extraEnv, run) {
  const server = startServer(extraEnv);
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
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    redirect: options.redirect
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

function sessionCookie(response) {
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}

test('bootstrap admin, login, password change and logout flow works', async () => {
  const dbPath = await tempDbPath();
  await withServer({
    DB_PATH: dbPath,
    BOOTSTRAP_ADMIN_USERNAME: 'admin',
    BOOTSTRAP_ADMIN_PASSWORD: 'password123',
    BOOTSTRAP_ADMIN_DISPLAY_NAME: 'Bootstrap Admin'
  }, async (baseUrl) => {
    const unauthSession = await jsonFetch(`${baseUrl}/api/session`);
    assert.deepEqual(unauthSession.data, {
      authenticated: false,
      user: null,
      capabilities: {
        viewDashboard: false,
        viewEditor: false,
        viewAllPrinters: false,
        operateAllPrinters: false,
        editMessages: false,
        configurePrinters: false,
        manageUsers: false,
        accessDiagnostics: false,
        viewFaultHistory: false,
        viewAudit: false
      },
      devIdentityEnabled: false,
      developmentIdentityActive: false,
      passwordChangeRequired: false
    });

    const page = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /^\/login/);

    const invalid = await jsonFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'admin', password: 'bad-password' }
    });
    assert.equal(invalid.response.status, 401);
    assert.equal(invalid.data.code, 'INVALID_LOGIN');

    const login = await jsonFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'admin', password: 'password123' }
    });
    assert.equal(login.response.ok, true);
    assert.equal(login.data.user.username, 'admin');
    assert.equal(login.data.passwordChangeRequired, true);
    assert.equal(login.data.redirectTo, '/change-password');
    assert.equal(login.data.user.passwordHash, undefined);

    let cookie = sessionCookie(login.response);
    const blocked = await jsonFetch(`${baseUrl}/api/printers`, { headers: { Cookie: cookie } });
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');

    const changed = await jsonFetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { currentPassword: 'password123', newPassword: 'new-password-123' }
    });
    assert.equal(changed.response.ok, true);
    cookie = sessionCookie(changed.response);

    const session = await jsonFetch(`${baseUrl}/api/session`, { headers: { Cookie: cookie } });
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.user.username, 'admin');
    assert.equal(session.data.capabilities.manageUsers, true);

    const users = await jsonFetch(`${baseUrl}/api/users`, { headers: { Cookie: cookie } });
    assert.equal(users.response.ok, true);
    assert.equal(users.data[0].passwordHash, undefined);

    const wildcardUser = await jsonFetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {
        username: 'lineop',
        displayName: 'Line Operator',
        password: 'password123',
        roles: ['operator'],
        printerIds: ['*'],
        enabled: true,
        mustChangePassword: true
      }
    });
    assert.equal(wildcardUser.response.status, 400);
    assert.match(wildcardUser.data.error, /Wildcard/);

    const created = await jsonFetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {
        username: 'lineop',
        displayName: 'Line Operator',
        password: 'password123',
        roles: ['operator'],
        printerIds: ['coder-1'],
        enabled: true,
        mustChangePassword: true
      }
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(created.data.user.printerIds, ['coder-1']);

    const logout = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {}
    });
    assert.equal(logout.response.ok, true);
    const afterLogout = await jsonFetch(`${baseUrl}/api/printers`, { headers: { Cookie: cookie } });
    assert.equal(afterLogout.response.status, 401);
  });

  const db = new Database(dbPath, { readonly: true });
  const user = db.prepare('SELECT username, password_hash FROM users WHERE username = ?').get('admin');
  db.close();
  assert.equal(user.username, 'admin');
  assert.match(user.password_hash, /^scrypt:/);
});

test('bootstrap admin is created once and not overwritten', async () => {
  const dbPath = await tempDbPath();
  await withServer({
    DB_PATH: dbPath,
    BOOTSTRAP_ADMIN_USERNAME: 'admin',
    BOOTSTRAP_ADMIN_PASSWORD: 'password123'
  }, async () => {});

  await withServer({
    DB_PATH: dbPath,
    BOOTSTRAP_ADMIN_USERNAME: 'otheradmin',
    BOOTSTRAP_ADMIN_PASSWORD: 'password456'
  }, async () => {});

  const db = new Database(dbPath, { readonly: true });
  const users = db.prepare('SELECT username FROM users ORDER BY username').all();
  db.close();
  assert.deepEqual(users, [{ username: 'admin' }]);
});

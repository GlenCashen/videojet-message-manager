import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
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

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('printer agent owns local emulators and registers claimed message definitions', async (t) => {
  const [mainPort, emulatorPort] = await Promise.all([freePort(), freePort()]);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vmm-agent-emulator-'));
  const configPath = path.join(tempDir, 'printers.json');
  const statePath = path.join(tempDir, 'state.json');
  await fs.writeFile(configPath, JSON.stringify([{
    id: 'agent-emulator',
    name: 'Agent Emulator',
    location: 'Test line',
    host: '127.0.0.1',
    port: emulatorPort,
    model: '1620',
    enabled: true,
    mode: 'emulator'
  }]), 'utf8');

  const payload = {
    protocolVersion: 1,
    releaseId: 'release-1',
    printerId: 'agent-emulator',
    plannedProductionAt: '2026-06-22T00:00:00.000Z',
    message: {
      id: 'new-stored-message',
      displayName: 'New stored message',
      printerMessageName: 'CAT TEST MESSAGE',
      fields: [{ key: 'batch', label: 'Batch', printerFieldName: 'BATCH', required: true, maxLength: 30, transform: 'uppercase' }],
      dateRule: { type: 'offset-months', months: 0, format: 'DD/MM/YYYY' },
      timeRule: { type: 'production-time', format: 'HH:mm:ss' },
      previewLines: ['{{batch}}']
    },
    fields: { batch: 'TEST-123' },
    expectedRendered: 'TEST-123'
  };
  const job = {
    id: 'job-1',
    payload,
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  };
  let claimed = false;
  let completed;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const main = http.createServer((request, response) => {
    if (request.url === '/api/printer-agent/v1/heartbeat') return json(response, 200, { ok: true });
    if (request.url === '/api/printer-agent/v1/jobs/claim') {
      if (claimed) return response.writeHead(204).end();
      claimed = true;
      return json(response, 200, { ok: true, job });
    }
    if (request.url === '/api/printer-agent/v1/jobs/job-1/complete') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        completed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        json(response, 200, { ok: true });
        resolveCompletion();
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => main.listen(mainPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => main.close(resolve)));

  const child = spawn(process.execPath, ['printer-agent.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAIN_SERVER_URL: `http://127.0.0.1:${mainPort}`,
      PRINTER_AGENT_ID: 'test-agent',
      PRINTER_AGENT_TOKEN: 'test-token',
      PRINTER_AGENT_CONFIG: configPath,
      PRINTER_AGENT_STATE: statePath,
      PRINTER_AGENT_ALLOW_HTTP: 'true',
      PRINTER_AGENT_POLL_MS: '250',
      PRINTER_AGENT_HEARTBEAT_MS: '1000',
      BETWEEN_COMMAND_DELAY_MS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  let timeout;
  try {
    await Promise.race([
      completion,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Agent did not complete the job.\n${output.join('')}`)), 8000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));

  assert.equal(completed.payloadHash, job.payloadHash);
  assert.equal(completed.result.ok, true, JSON.stringify(completed.result));
  assert.equal(completed.result.messageMatches, true);
  assert.equal(completed.result.selectedMessage, 'CAT TEST MESSAGE');
  assert.equal(completed.result.expectedOutput.rendered, 'TEST-123');
});

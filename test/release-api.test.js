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
      // Startup can briefly refuse connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start.');
}

async function jsonFetch(url, { method = 'GET', body, role = 'qa' } = {}) {
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

test('QA, planner and packaging leader complete release approval without contacting a printer', async () => {
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
      DB_PATH: path.join(tmpdir(), `vmm-release-api-${port}.db`),
      ENABLE_DEV_IDENTITY: 'true',
      DEV_USER_ROLE: 'qa'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForServer(baseUrl, child, output);
    const messageResult = await jsonFetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      role: 'qa',
      body: {
        id: 'tbundrc-code',
        displayName: 'TBUNDRC package code',
        enabled: true,
        fields: [
          { key: 'brew', label: 'Brew code', printerFieldName: 'BREW', required: true, maxLength: 30, transform: 'uppercase' },
          { key: 'batch', label: 'Batch code', printerFieldName: 'BATCH', required: true, maxLength: 30, transform: 'uppercase' }
        ],
        dateRule: { type: 'offset-months', months: 15 },
        previewLines: ['{{brew}}{{batch}}', 'BBD: {{bestBeforeDate}} {{currentTime}}'],
        printerAssignments: [{ printerId: 'coder-1', printerMessageName: 'TBUNDRC', enabled: true }]
      }
    });
    assert.equal(messageResult.response.status, 201, JSON.stringify(messageResult.data));
    assert.deepEqual(messageResult.data.message.fields.map((field) => field.key), ['brew', 'batch']);

    const masterResult = await jsonFetch(`${baseUrl}/api/product-masters`, {
      method: 'POST',
      role: 'qa',
      body: {
        productCode: 'TBUNDRC',
        displayName: 'Bundaberg Rum and Cola',
        nextRunNumber: 50,
        specification: {
          runPrefix: 'T', runWidth: 4, bestBeforeMonths: 15,
          messageId: 'tbundrc-code',
          fieldMappings: [
            { fieldKey: 'brew', source: 'run_code' },
            { fieldKey: 'batch', source: 'brew_sheet_product' }
          ],
          printerIds: ['coder-1']
        }
      }
    });
    assert.equal(masterResult.response.status, 201, JSON.stringify(masterResult.data));

    const draftResult = await jsonFetch(`${baseUrl}/api/batch-releases`, {
      method: 'POST',
      role: 'planner',
      body: {
        productMasterId: masterResult.data.master.id,
        brewSheetProduct: 'TBUNDRC-50',
        brewNumber: 'H0477',
        batchNumber: 'FV27',
        plannedProductionAt: '2026-06-18T04:32:08.000Z',
        printerIds: ['coder-1']
      }
    });
    assert.equal(draftResult.response.status, 201, JSON.stringify(draftResult.data));

    const submitted = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/submit`, {
      method: 'POST', role: 'planner', body: {}
    });
    assert.equal(submitted.data.release.status, 'pending_review');

    await jsonFetch(`${baseUrl}/api/debug/wsi-counters/reset`, { method: 'POST', role: 'admin' });
    const approved = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/approve`, {
      method: 'POST', role: 'packaging_leader', body: {}
    });
    assert.equal(approved.response.ok, true, JSON.stringify(approved.data));
    assert.equal(approved.data.release.runCode, 'T0050');
    assert.equal(approved.data.release.expectedOutput.rendered, 'T0050TBUNDRC-50\nBBD: 18/09/2027 04:32:08');
    assert.deepEqual((await jsonFetch(`${baseUrl}/api/debug/wsi-counters`, { role: 'admin' })).data, {});
  } finally {
    const exitPromise = child.exitCode === null ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
    child.kill();
    await exitPromise;
  }
});

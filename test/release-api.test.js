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
      PRINTER_EXECUTION_MODE: 'local',
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
    const canFields = await jsonFetch(`${baseUrl}/api/printer-user-fields?printerId=coder-1`, { role: 'qa' });
    const brewField = canFields.data.find((field) => field.key === 'brew');
    const batchField = canFields.data.find((field) => field.key === 'batch');
    assert.ok(brewField);
    assert.ok(batchField);
    const messageResult = await jsonFetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      role: 'qa',
      body: {
        id: 'tbundrc-code',
        displayName: 'TBUNDRC package code',
        enabled: true,
        fieldIds: [brewField.id, batchField.id],
        dateRule: { type: 'offset-months', months: 15 },
        previewLines: ['{{brew}}{{batch}}', 'BBD: {{bestBeforeDate}} {{currentTime}}'],
        printerAssignments: [{ printerId: 'coder-1', printerMessageName: 'TBUNDRC', enabled: true }]
      }
    });
    assert.equal(messageResult.response.status, 201, JSON.stringify(messageResult.data));
    assert.deepEqual(messageResult.data.message.fields.map((field) => field.key), ['brew', 'batch']);
    assert.equal(messageResult.data.message.printerAssignments.length, 1);

    const bottleFields = await jsonFetch(`${baseUrl}/api/printer-user-fields?printerId=coder-2`, { role: 'qa' });
    const bottleBatch = bottleFields.data.find((field) => field.key === 'batch');
    const wrongPrinterField = await jsonFetch(`${baseUrl}/api/messages`, {
      method: 'POST', role: 'qa', body: {
        id: 'wrong-printer-field', displayName: 'Wrong printer field', enabled: true,
        fieldIds: [bottleBatch.id],
        dateRule: { type: 'offset-months', months: 12 },
        previewLines: ['{{batch}}'],
        printerAssignments: [{ printerId: 'coder-1', printerMessageName: 'WRONG FIELD', enabled: true }]
      }
    });
    assert.equal(wrongPrinterField.response.status, 400);
    assert.match(wrongPrinterField.data.error, /belong to the assigned printer/i);

    const customField = await jsonFetch(`${baseUrl}/api/printers/coder-1/user-fields`, {
      method: 'POST', role: 'qa', body: {
        key: 'batch1', label: 'Batch 1', printerFieldName: 'Batch1', required: true, maxLength: 30, transform: 'uppercase'
      }
    });
    assert.equal(customField.response.status, 201, JSON.stringify(customField.data));
    assert.equal(customField.data.field.printerFieldName, 'Batch1');

    const masterResult = await jsonFetch(`${baseUrl}/api/product-masters`, {
      method: 'POST',
      role: 'qa',
      body: {
        productCode: 'TBUNDRC',
        packagingCategory: 'cans',
        displayName: 'Bundaberg Rum and Cola',
        nextRunNumber: 50,
        specification: {
          runPrefix: 'T', runWidth: 4, defaultBrewSheetProduct: 'TBUNDRC',
          printerConfigurations: [{
            printerId: 'coder-1', messageId: 'tbundrc-code',
            fieldMappings: [
              { fieldKey: 'brew', source: 'run_code' },
              { fieldKey: 'batch', source: 'brew_sheet_product' }
            ]
          }]
        }
      }
    });
    assert.equal(masterResult.response.status, 201, JSON.stringify(masterResult.data));

    const missingMasterReason = await jsonFetch(`${baseUrl}/api/product-masters/${masterResult.data.master.id}`, {
      method: 'PUT', role: 'qa', body: {
        displayName: 'Bundaberg Rum and Cola',
        nextRunNumber: 50,
        specification: masterResult.data.master.specification
      }
    });
    assert.equal(missingMasterReason.response.status, 400);
    assert.match(missingMasterReason.data.error, /change reason/i);
    const versionedMaster = await jsonFetch(`${baseUrl}/api/product-masters/${masterResult.data.master.id}`, {
      method: 'PUT', role: 'qa', body: {
        displayName: 'Bundaberg Rum and Cola',
        nextRunNumber: 50,
        specification: masterResult.data.master.specification,
        changeReason: 'Confirm the printer-specific field mappings.'
      }
    });
    assert.equal(versionedMaster.data.master.currentVersion, 2);
    const masterAudit = await jsonFetch(`${baseUrl}/api/logs?targetType=product-master&targetId=${masterResult.data.master.id}`, { role: 'qa' });
    assert.ok(masterAudit.data.some((event) => event.action === 'product-master-version-created'
      && event.details.reason === 'Confirm the printer-specific field mappings.'));

    const draftResult = await jsonFetch(`${baseUrl}/api/batch-releases`, {
      method: 'POST',
      role: 'planner',
      body: {
        productMasterId: masterResult.data.master.id,
        brewSheetProduct: 'TBUNDRC-50',
        brewNumber: 'H0477',
        plannedProductionAt: '2026-06-18T04:32:08.000Z',
        printerIds: ['coder-2']
      }
    });
    assert.equal(draftResult.response.status, 201, JSON.stringify(draftResult.data));
    assert.equal(draftResult.data.release.brewSheetProduct, 'TBUNDRC-50');
    assert.equal(draftResult.data.release.packagingCategory, 'cans');
    assert.deepEqual(draftResult.data.release.printerIds, ['coder-1']);

    const submitted = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/submit`, {
      method: 'POST', role: 'planner', body: {}
    });
    assert.equal(submitted.data.release.status, 'pending_review');

    const claimed = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/review-claim`, {
      method: 'POST', role: 'qa', body: {}
    });
    assert.equal(claimed.response.ok, true, JSON.stringify(claimed.data));
    assert.ok(claimed.data.release.reviewClaim);
    const competingClaim = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/review-claim`, {
      method: 'POST', role: 'packaging_leader', body: {}
    });
    assert.equal(competingClaim.response.status, 409);

    await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/review-claim`, {
      method: 'DELETE', role: 'qa'
    });

    await jsonFetch(`${baseUrl}/api/debug/wsi-counters/reset`, { method: 'POST', role: 'admin' });
    const approved = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/approve`, {
      method: 'POST', role: 'packaging_leader', body: {}
    });
    assert.equal(approved.response.ok, true, JSON.stringify(approved.data));
    assert.equal(approved.data.release.runCode, null);
    assert.equal(approved.data.release.expectedOutput, null);
    assert.deepEqual((await jsonFetch(`${baseUrl}/api/debug/wsi-counters`, { role: 'admin' })).data, {});

    const applied = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/targets/coder-1/apply`, {
      method: 'POST', role: 'operator', body: {}
    });
    assert.equal(applied.response.ok, true, JSON.stringify(applied.data));
    assert.equal(applied.data.release.runCode, 'T0050');
    assert.equal(applied.data.release.expectedOutput.rendered, 'T0050TBUNDRC-50\nBBD: 18/09/2027 04:32:08');
    assert.equal(applied.data.release.executionTargets[0].status, 'awaiting_print_check');
    const printChecked = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/targets/coder-1/print-check`, {
      method: 'POST', role: 'operator', body: { passed: true }
    });
    assert.equal(printChecked.response.ok, true, JSON.stringify(printChecked.data));
    assert.equal(printChecked.data.release.status, 'running');
    const ended = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/targets/coder-1/end-run`, {
      method: 'POST', role: 'operator', body: {}
    });
    assert.equal(ended.response.ok, true, JSON.stringify(ended.data));
    assert.equal(ended.data.release.status, 'completed');
    const executionAudit = await jsonFetch(`${baseUrl}/api/batch-releases/${draftResult.data.release.id}/audit`, { role: 'qa' });
    const executionActions = new Set(executionAudit.data.map((event) => event.action));
    assert.ok(executionActions.has('batch-release-review-claimed'));
    assert.ok(executionActions.has('batch-release-run-assigned'));
    assert.ok(executionActions.has('batch-release-application-sent'));
    assert.ok(executionActions.has('batch-release-print-verified'));
    assert.ok(executionActions.has('batch-release-running'));
    assert.ok(executionActions.has('batch-release-run-ended'));

    const rejectedDraft = await jsonFetch(`${baseUrl}/api/batch-releases`, {
      method: 'POST', role: 'planner', body: {
        productMasterId: masterResult.data.master.id,
        brewSheetProduct: 'TBUNDRC-51',
        brewNumber: 'H0111',
        plannedProductionAt: '2026-06-19T04:32:08.000Z',
        printerIds: ['coder-1']
      }
    });
    const rejectedId = rejectedDraft.data.release.id;
    await jsonFetch(`${baseUrl}/api/batch-releases/${rejectedId}/submit`, { method: 'POST', role: 'planner', body: {} });
    await jsonFetch(`${baseUrl}/api/batch-releases/${rejectedId}/reject`, { method: 'POST', role: 'qa', body: { reason: 'Brew number does not match' } });
    const directResubmit = await jsonFetch(`${baseUrl}/api/batch-releases/${rejectedId}/submit`, { method: 'POST', role: 'planner', body: {} });
    assert.equal(directResubmit.response.status, 409);
    const corrected = await jsonFetch(`${baseUrl}/api/batch-releases/${rejectedId}`, {
      method: 'PUT', role: 'planner', body: {
        brewSheetProduct: 'TBUNDRC-51',
        brewNumber: 'H0478',
        plannedProductionAt: '2026-06-19T04:32:08.000Z',
        printerIds: ['coder-1'],
        notes: 'Corrected after QA review'
      }
    });
    assert.equal(corrected.data.release.status, 'draft');
    assert.equal(corrected.data.release.brewNumber, 'H0478');

    const audit = await jsonFetch(`${baseUrl}/api/batch-releases/${rejectedId}/audit`, { role: 'qa' });
    assert.equal(audit.response.ok, true, JSON.stringify(audit.data));
    assert.deepEqual(new Set(audit.data.map((event) => event.action)), new Set([
      'batch-release-created', 'batch-release-submitted', 'batch-release-rejected', 'batch-release-updated'
    ]));
    assert.ok(audit.data.every((event) => event.targetType === 'batch-release' && event.targetId === rejectedId));

    const globalAudit = await jsonFetch(`${baseUrl}/api/logs?targetType=batch-release&targetId=${rejectedId}`, { role: 'qa' });
    assert.equal(globalAudit.response.ok, true);
    assert.ok(globalAudit.data.some((event) => event.action === 'batch-release-updated'));
  } finally {
    const exitPromise = child.exitCode === null ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
    child.kill();
    await exitPromise;
  }
});

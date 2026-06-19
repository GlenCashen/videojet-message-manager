import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('operation-failed SSE is not applied as printer status', async () => {
  const events = await readFile('public/js/events.js', 'utf8');
  const operationFailedBlock = events.match(/source\.addEventListener\('operation-failed'[\s\S]*?\n  \}\);/);
  assert.ok(operationFailedBlock, 'operation-failed listener should exist');
  assert.equal(operationFailedBlock[0].includes('onPrinterStatus'), false);
  assert.equal(operationFailedBlock[0].includes('onOperationFailed'), true);
});

test('message update catch path does not synthesize printer offline state', async () => {
  const page = await readFile('public/printer-page.js', 'utf8');
  const confirmStart = page.indexOf('async function confirmPrinterUpdate()');
  const nextFunction = page.indexOf('\nfunction markServerConnected()', confirmStart);
  const confirmBlock = page.slice(confirmStart, nextFunction);
  assert.ok(confirmBlock.includes('showUpdateResult(error.data)'));
  assert.equal(confirmBlock.includes('online: false'), false);
});

test('top navigation does not expose Users as a top-level link', async () => {
  const navigation = await readFile('public/js/navigation.js', 'utf8');
  assert.equal(navigation.includes("navLink('/editor#users', 'Users'"), false);
  assert.equal(navigation.includes("navLink('/dashboard#my-printers'"), false);
});

test('printer page does not force dashboard active nav state', async () => {
  const page = await readFile('public/printer-page.js', 'utf8');
  assert.equal(page.includes("renderNavigation(elements.nav, { active: '/dashboard' })"), false);
  assert.ok(page.includes('renderNavigation(elements.nav, { active: window.location.pathname })'));
});

test('traffic-light printer state helper is shared by dashboard and printer page', async () => {
  const statusUi = await readFile('public/js/status-ui.js', 'utf8');
  const dashboard = await readFile('public/js/dashboard.js', 'utf8');
  const printerPage = await readFile('public/printer-page.js', 'utf8');

  assert.ok(statusUi.includes('function trafficLightMarkup'));
  assert.ok(dashboard.includes('trafficLightMarkup(coder.decodedStatus'));
  assert.ok(printerPage.includes('trafficLightMarkup(decodedStatus'));
});

test('manual message changes retain guarded review but operator-only accounts use releases', async () => {
  const dashboard = await readFile('public/js/viewer-dashboard.js', 'utf8');
  const dialog = await readFile('public/js/operator-message-dialog.js', 'utf8');

  assert.ok(dashboard.includes('canOperatePrinter(printer.id)'));
  assert.ok(dashboard.includes('manualMessageChangeAllowed'));
  assert.ok(dialog.includes("/preview`"));
  assert.ok(dialog.includes("/set`"));
  assert.ok(dialog.includes('expectedRevision: status.revision'));
  assert.ok(dialog.includes('/api/printer/current-message?printerId='));
  assert.ok(dialog.includes('Message change sent, but readback failed:'));
});

test('production releases require an independent review and expose no direct operator send', async () => {
  const editorHtml = await readFile('public/index.html', 'utf8');
  const dashboardHtml = await readFile('public/dashboard.html', 'utf8');
  const releases = await readFile('public/js/release-workflow.js', 'utf8');

  assert.ok(editorHtml.includes('id="releaseWorkflowPanel"'));
  assert.ok(editorHtml.includes('Approve and reserve run'));
  assert.ok(releases.includes('releaseApprovalCheck'));
  assert.ok(releases.includes("mode === 'approve'"));
  assert.ok(releases.includes('/review-claim'));
  assert.ok(releases.includes('reviewHeartbeat'));
  assert.ok(releases.includes('is reviewing this release now'));
  assert.equal(dashboardHtml.includes('Accept and send'), false);
});

test('operator dashboard exposes approved release send and first-print verification', async () => {
  const dashboard = await readFile('public/dashboard.html', 'utf8');
  const queue = await readFile('public/js/operator-release-queue.js', 'utf8');
  assert.ok(dashboard.includes('id="operatorReleaseList"'));
  assert.ok(dashboard.includes('id="operatorReleaseConfirmationCheck"'));
  assert.ok(dashboard.includes('id="verifyOperatorPrint"'));
  assert.ok(queue.includes('/apply`'));
  assert.ok(queue.includes('/print-check`'));
  assert.ok(dashboard.includes('First print verified'));
});

test('new messages define fields that product masters infer', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const messageConfig = await readFile('public/js/message-config.js', 'utf8');
  const releases = await readFile('public/js/release-workflow.js', 'utf8');

  assert.ok(html.includes('id="newMessageButton"'));
  assert.equal(html.includes('id="masterRunField"'), false);
  assert.equal(html.includes('id="masterBatchField"'), false);
  assert.ok(html.includes('id="masterFieldMappings"'));
  assert.ok(messageConfig.includes("method: creating ? 'POST' : 'PUT'"));
  assert.ok(releases.includes('function renderMessageSummary()'));
  assert.ok(releases.includes('field.printerFieldName'));
  assert.ok(releases.includes("['run_code', 'Tracked product run (optional)']"));
});

test('printer editor persists the current-message readback override', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const editor = await readFile('public/js/editor.js', 'utf8');

  assert.ok(html.includes('id="printerReadbackMode"'));
  assert.ok(html.includes('value="auto"'));
  assert.ok(html.includes('value="enabled"'));
  assert.ok(html.includes('value="disabled"'));
  assert.ok(editor.includes("printer.readbackMode || 'auto'"));
  assert.ok(editor.includes('readbackMode: elements.printerReadbackMode.value'));
});

test('printer editor exposes create and archive controls without a three-printer limit', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const editor = await readFile('public/js/editor.js', 'utf8');
  const dashboard = await readFile('public/js/dashboard.js', 'utf8');

  assert.ok(html.includes('id="newPrinterButton"'));
  assert.ok(html.includes('id="deletePrinterButton"'));
  assert.ok(editor.includes("method: existing ? 'PUT' : 'POST'"));
  assert.ok(editor.includes("method: 'DELETE'"));
  assert.equal(dashboard.includes('Only three coders are supported'), false);
});

test('admin user simulation has start and return controls', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const users = await readFile('public/js/user-management.js', 'utf8');
  const navigation = await readFile('public/js/navigation.js', 'utf8');

  assert.ok(html.includes('id="simulateUserButton"'));
  assert.ok(users.includes("'/api/admin/simulate-user'"));
  assert.ok(navigation.includes("method: 'DELETE'"));
  assert.ok(navigation.includes('Return to admin'));
});

test('page navigation closes the active event stream and API requests are bounded', async () => {
  const events = await readFile('public/js/events.js', 'utf8');
  const api = await readFile('public/js/api.js', 'utf8');

  assert.ok(events.includes("window.addEventListener('pagehide', closeForNavigation"));
  assert.ok(events.includes("window.addEventListener('beforeunload', closeForNavigation"));
  assert.ok(events.includes('activeSource.close()'));
  assert.ok(api.includes('const controller = new AbortController()'));
  assert.ok(api.includes("method === 'GET' ? 10000 : 30000"));
  assert.ok(api.includes('Request timed out after'));
});

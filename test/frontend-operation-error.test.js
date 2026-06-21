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
  const printerPage = await readFile('public/printer-page.js', 'utf8');
  const printer = await readFile('public/printer.html', 'utf8');

  assert.equal(dashboard.includes('Set message'), false);
  assert.equal(dashboard.includes('createOperatorMessageDialog'), false);
  assert.ok(printerPage.includes("/preview`"));
  assert.ok(printerPage.includes("/set`"));
  assert.ok(printerPage.includes('expectedRevision: latestStatus?.revision'));
  assert.ok(printerPage.includes('reason,'));
  assert.ok(printer.includes('id="manualMessageReason"'));
  assert.ok(printerPage.includes('/api/printer/current-message?printerId='));
});

test('production releases require an independent review and expose no direct operator send', async () => {
  const editorHtml = await readFile('public/index.html', 'utf8');
  const dashboardHtml = await readFile('public/dashboard.html', 'utf8');
  const releases = await readFile('public/js/release-workflow.js', 'utf8');

  assert.ok(editorHtml.includes('id="releaseWorkflowPanel"'));
  assert.ok(editorHtml.includes('Approve release'));
  assert.ok(releases.includes('releaseApprovalCheck'));
  assert.ok(releases.includes("mode === 'approve'"));
  assert.ok(releases.includes('/review-claim'));
  assert.ok(releases.includes('reviewHeartbeat'));
  assert.ok(releases.includes('is reviewing this release now'));
  assert.equal(dashboardHtml.includes('Accept and send'), false);
});

test('individual printer page exposes release execution while dashboard stays read-only', async () => {
  const dashboard = await readFile('public/dashboard.html', 'utf8');
  const printer = await readFile('public/printer.html', 'utf8');
  const printerPage = await readFile('public/printer-page.js', 'utf8');
  const queue = await readFile('public/js/operator-release-queue.js', 'utf8');
  const styles = await readFile('public/styles.css', 'utf8');
  assert.equal(dashboard.includes('id="operatorReleaseList"'), false);
  assert.equal(dashboard.includes('id="setMessageDialog"'), false);
  assert.ok((await readFile('public/js/viewer-dashboard.js', 'utf8')).includes('Current running job'));
  assert.ok((await readFile('public/js/viewer-dashboard.js', 'utf8')).includes('loadRunningReleases'));
  assert.ok(printer.includes('id="currentOperatorRelease"'));
  assert.ok(printer.includes('id="nextOperatorRelease"'));
  assert.ok(printer.includes('id="upcomingReleaseSearch"'));
  assert.ok(printer.includes('id="completedReleaseSearch"'));
  assert.ok(printer.includes('id="viewCompletedReleases"'));
  assert.ok(printer.includes('id="operatorReleaseConfirmationCheck"'));
  assert.ok(printer.includes('id="verifyOperatorPrint"'));
  assert.ok(printerPage.includes('printerId,'));
  assert.ok(queue.includes('target.printerId === printerId'));
  assert.ok(queue.includes('/apply`'));
  assert.ok(queue.includes('/print-check`'));
  assert.ok(queue.includes('/end-run`'));
  assert.ok(queue.includes('/return-for-review`'));
  assert.ok(queue.includes("target.status !== 'completed'"));
  assert.ok(queue.includes('/api/batch-releases?limit=500'));
  assert.ok(queue.includes('completedTargets.length'));
  assert.ok(printer.includes('First print verified'));
  assert.match(styles, /\.operator-release-panel\s*\{[\s\S]*?color:\s*#172033/);
  assert.match(styles, /\.operator-release-preview pre\s*\{[^}]*color:\s*#172033/);
});

test('new messages define fields that product masters infer', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const messageConfig = await readFile('public/js/message-config.js', 'utf8');
  const releases = await readFile('public/js/release-workflow.js', 'utf8');

  assert.ok(html.includes('id="newMessageButton"'));
  assert.ok(html.includes('id="addMessageField"'));
  assert.ok(html.includes('id="messageTokenPalette"'));
  assert.ok(html.includes('id="messageLineBuilder"'));
  assert.equal(html.includes('id="messageFieldsJson"'), false);
  assert.equal(html.includes('id="messagePreviewLines"'), false);
  assert.ok(messageConfig.includes("draggable: 'true'"));
  assert.ok(messageConfig.includes('dataTransfer.getData'));
  assert.equal(html.includes('id="masterRunField"'), false);
  assert.equal(html.includes('id="masterBatchField"'), false);
  assert.ok(html.includes('id="masterPrinterConfigurations"'));
  assert.ok(html.includes('id="productMasterList"'));
  assert.ok(html.includes('id="productMasterSearch"'));
  assert.ok(messageConfig.includes("method: creating ? 'POST' : 'PUT'"));
  assert.ok(releases.includes('function renderMasterPrinterConfigurations('));
  assert.ok(releases.includes('function renderMasterRegister()'));
  assert.ok(releases.includes("method: editing ? 'PUT' : 'POST'"));
  assert.ok(releases.includes('printerConfigurations'));
  assert.ok(releases.includes('renderConfiguredLines'));
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

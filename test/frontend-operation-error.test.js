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

test('printer page keeps operator update notices from being cleared by status polls', async () => {
  const page = await readFile('public/printer-page.js', 'utf8');
  const applyStart = page.indexOf('function applyPrinterStatus(value)');
  const applyEnd = page.indexOf('\nasync function loadMessages()', applyStart);
  const applyBlock = page.slice(applyStart, applyEnd);
  const directMessageNotices = [...page.matchAll(/setNotice\(elements\.message/g)];

  assert.ok(page.includes('let operatorNoticeSticky = false'));
  assert.ok(page.includes('function setOperatorNotice'));
  assert.ok(applyBlock.includes('setOperatorNotice();'));
  assert.ok(applyBlock.includes('value.operatorMessage || value.error'));
  assert.equal(directMessageNotices.length, 2, 'only the setOperatorNotice helper should call setNotice for the operator message node');
});

test('printer page only shows message mismatch when requested and selected messages differ', async () => {
  const page = await readFile('public/printer-page.js', 'utf8');
  const showStart = page.indexOf('function showUpdateResult(result)');
  const showEnd = page.indexOf('\nasync function confirmPrinterUpdate()', showStart);
  const showBlock = page.slice(showStart, showEnd);

  assert.ok(showBlock.includes('const actualMismatch = Boolean(requestedMessage && result.selectedMessage && result.selectedMessage !== requestedMessage)'));
  assert.ok(showBlock.includes('if (result.ok && result.messageMatches)'));
  assert.ok(showBlock.includes("result.operatorMessage || 'Message update failed'"));
  assert.equal(showBlock.includes('if (result.messageMatches) {'), false);
});

test('release completion events refresh an open send dialog immediately', async () => {
  const queue = await readFile('public/js/operator-release-queue.js', 'utf8');
  assert.ok(queue.includes('refreshOpenDialog'));
  assert.ok(queue.includes('refresh: () => load({ refreshOpenDialog: true })'));
  assert.equal(queue.includes('return { load, refresh: load }'), false);
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

test('audited manual change closes before submission and tracks queued agent completion', async () => {
  const page = await readFile('public/printer-page.js', 'utf8');
  const confirmStart = page.indexOf('async function confirmPrinterUpdate()');
  const confirmEnd = page.indexOf('\nfunction markServerConnected()', confirmStart);
  const block = page.slice(confirmStart, confirmEnd);
  assert.ok(block.indexOf('elements.manualDialog.close()') < block.indexOf('await postJson('));
  assert.match(block, /if \(result\.queued\)/);
  assert.match(page, /value\.operationId === pendingManualJobId/);
  assert.doesNotMatch(page, /Requested: \$\{result\.requestedMessage\}/);
});

test('production releases require an independent review and expose no direct operator send', async () => {
  const editorHtml = await readFile('public/index.html', 'utf8');
  const productionHtml = await readFile('public/production-releases.html', 'utf8');
  const productionPage = await readFile('public/production-releases.js', 'utf8');
  const dashboardHtml = await readFile('public/dashboard.html', 'utf8');
  const releases = await readFile('public/js/release-workflow.js', 'utf8');

  assert.ok(editorHtml.includes('id="releaseWorkflowPanel" class="panel message-config-panel hidden"'));
  assert.ok(productionHtml.includes('id="releaseWorkflowPanel"'));
  assert.ok(productionHtml.includes('id="productionReleasesTab"'));
  assert.ok(productionHtml.includes('id="productionMastersTab"'));
  assert.ok(productionHtml.includes('id="releaseBrewProduct"'));
  assert.ok(productionHtml.includes('id="releaseBrewNumber"'));
  assert.equal(productionHtml.includes('id="releaseBatchNumber"'), false);
  assert.ok(productionHtml.includes('id="releaseMasterSearch"'));
  assert.ok(productionHtml.includes('id="releaseExpectedMessages"'));
  assert.ok(productionHtml.includes('id="releasePagination"'));
  assert.ok(productionHtml.includes('Production Coding Releases'));
  assert.ok(productionHtml.includes('Awaiting independent review'));
  assert.ok(productionHtml.includes('Approved / ready to send'));
  assert.ok(productionHtml.includes('id="masterChangeReason"'));
  assert.ok(productionHtml.includes('Approve release'));
  assert.ok(productionPage.includes('onBatchReleaseChanged'));
  assert.ok(productionPage.includes('setInterval'));
  assert.ok(releases.includes("paged: 'true'"));
  assert.ok(releases.includes('release-expanded'));
  assert.ok(releases.includes('state.releasePage.offset'));
  assert.ok(releases.includes('releaseApprovalCheck'));
  assert.ok(releases.includes("mode === 'approve'"));
  assert.ok(releases.includes('/review-claim'));
  assert.ok(releases.includes('reviewHeartbeat'));
  assert.ok(releases.includes('is reviewing this release now'));
  assert.ok(releases.includes('Return for correction'));
  assert.ok(releases.includes('Create new version'));
  assert.ok(releases.includes('Attention required — printer state uncertain'));
  assert.equal(releases.includes("['draft', 'rejected'].includes(release.status) || approvedUnstarted"), false);
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
  assert.ok(queue.includes("target.status !== 'ended'"));
  assert.ok(queue.includes('function isProductionRelease'));
  assert.ok(queue.includes("release.status !== 'completed' && target.status !== 'ended'"));
  assert.ok(queue.includes('/api/batch-releases?limit=500'));
  assert.ok(queue.includes('completedTargets.length'));
  assert.ok(printer.includes('First print verified'));
  assert.ok(queue.includes('Confirm the first printed code matches the expected printed code'));
  assert.ok(queue.includes('physically checked the printer'));
  assert.ok(queue.includes('Retry approved message'));
  assert.ok(queue.includes('partiallyCompleted'));
  assert.match(styles, /\.operator-release-panel\s*\{[\s\S]*?color:\s*#172033/);
  assert.match(styles, /\.operator-release-preview pre\s*\{[^}]*color:\s*#172033/);
});

test('new messages define fields that product masters infer', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const messageConfig = await readFile('public/js/message-config.js', 'utf8');
  const releases = await readFile('public/js/release-workflow.js', 'utf8');

  assert.ok(html.includes('id="newMessageButton"'));
  assert.ok(html.includes('id="userFieldPrinter"'));
  assert.ok(html.includes('id="printerUserFieldForm"'));
  assert.ok(html.includes('id="printerUserFieldLabel"'));
  assert.ok(html.includes('id="printerUserFieldName"'));
  assert.equal(html.includes('id="printerUserFieldType"'), false);
  assert.ok(html.includes('id="messageFieldChoices"'));
  assert.ok(html.includes('id="messagePrinter"'));
  assert.ok(html.includes('id="messageTokenPalette"'));
  assert.ok(html.includes('id="messageLineBuilder"'));
  assert.equal(html.includes('id="messageFieldsJson"'), false);
  assert.equal(html.includes('id="messagePreviewLines"'), false);
  assert.ok(messageConfig.includes("draggable: 'true'"));
  assert.ok(messageConfig.includes('dataTransfer.getData'));
  assert.ok(messageConfig.includes("apiJson('/api/printer-user-fields')"));
  assert.ok(messageConfig.includes('function fieldKey'));
  assert.ok(messageConfig.includes('function printerFieldName'));
  assert.ok(html.includes('Messages belong to one printer'));
  assert.equal(html.includes('id="masterRunField"'), false);
  assert.equal(html.includes('id="masterBatchField"'), false);
  assert.ok(html.includes('id="masterPrinterConfigurations"'));
  assert.ok(html.includes('id="productMasterList"'));
  assert.ok(html.includes('id="productMasterSearch"'));
  assert.ok(html.includes('id="messageMasterUsage"'));
  assert.ok(html.includes('id="messageMasterUsageList"'));
  assert.ok(messageConfig.includes("apiJson('/api/product-masters')"));
  assert.ok(messageConfig.includes('masterSearch='));
  assert.ok(messageConfig.includes("method: creating ? 'POST' : 'PUT'"));
  assert.ok(releases.includes('function renderMasterPrinterConfigurations('));
  assert.ok(releases.includes('function renderMasterRegister()'));
  assert.ok(releases.includes("method: editing ? 'PUT' : 'POST'"));
  assert.ok(releases.includes('printerConfigurations'));
  assert.ok(releases.includes('renderConfiguredLines'));
  assert.ok(releases.includes('field.printerFieldName'));
  assert.ok(releases.includes("['run_code', 'Tracked product run (optional)']"));
});

test('new releases prefill an editable BATCH prefix and inherit category and printers', async () => {
  const html = await readFile('public/production-releases.html', 'utf8');
  const source = await readFile('public/js/release-workflow.js', 'utf8');
  assert.ok(html.includes('id="releasePackagingCategory"'));
  assert.ok(html.includes('id="releaseBrewProduct"'));
  assert.ok(html.includes('id="releasePrinters"'));
  assert.ok(html.includes('id="masterPackagingCategory"'));
  assert.ok(html.includes('id="masterBatchCode"'));
  assert.equal(html.includes('id="releaseBrewProduct" readonly'), false);
  assert.match(source, /brewSheetProduct: nodes\.releaseBrewProduct\.value/);
  assert.match(source, /defaultBrewSheetProduct/);
  assert.match(source, /applySelectedMasterDefaults\(\)/);
  assert.match(source, /Printers inherited from product master/);
  assert.equal(source.includes("querySelectorAll('[data-release-printer]')"), false);
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

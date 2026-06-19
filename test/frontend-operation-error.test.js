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

test('assigned operators can review and confirm a dashboard message change', async () => {
  const dashboard = await readFile('public/js/viewer-dashboard.js', 'utf8');
  const dialog = await readFile('public/js/operator-message-dialog.js', 'utf8');

  assert.ok(dashboard.includes('canOperatePrinter(printer.id)'));
  assert.ok(dashboard.includes("dataset: { action: 'set-message', printerId: printer.id }"));
  assert.ok(dialog.includes("/preview`"));
  assert.ok(dialog.includes("/set`"));
  assert.ok(dialog.includes('expectedRevision: status.revision'));
  assert.ok(dialog.includes('/api/printer/current-message?printerId='));
  assert.ok(dialog.includes('Message change sent, but readback failed:'));
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

const $ = (id) => document.getElementById(id);
const elements = {
  ip: $('ip'), port: $('port'), messageName: $('messageName'), fieldName: $('fieldName'), fieldValue: $('fieldValue'),
  checkButton: $('checkButton'), setButton: $('setButton'), refreshLogs: $('refreshLogs'),
  expectedMessage: $('expectedMessage'), selectedMessage: $('selectedMessage'), printerStatus: $('printerStatus'),
  lastResult: $('lastResult'), connectionBadge: $('connectionBadge'), errorBox: $('errorBox'), logBody: $('logBody'),
  useEmulator: $('useEmulator'), modeHelp: $('modeHelp'), emulatorPanel: $('emulatorPanel'),
  emulatorMessage: $('emulatorMessage'), emulatorStatus: $('emulatorStatus'), emulatorDelay: $('emulatorDelay'),
  emulatorEnabled: $('emulatorEnabled'), failNextCommand: $('failNextCommand'), saveEmulator: $('saveEmulator'),
  resetEmulator: $('resetEmulator'), emulatorFields: $('emulatorFields')
};
let config = {};
let realPrinter = { ip: '192.168.100.2', port: 3100 };

function payload() {
  return { ip: elements.ip.value.trim(), port: Number(elements.port.value), messageName: elements.messageName.value, fieldName: elements.fieldName.value.trim(), fieldValue: elements.fieldValue.value };
}
function setBusy(busy) { elements.checkButton.disabled = busy; elements.setButton.disabled = busy; }
function showError(message = '') { elements.errorBox.textContent = message; elements.errorBox.classList.toggle('hidden', !message); }
function setBadge(ok, text) { elements.connectionBadge.textContent = text; elements.connectionBadge.className = `badge ${ok === null ? 'neutral' : ok ? 'good' : 'bad'}`; }
async function request(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function checkPrinter() {
  setBusy(true); showError(''); setBadge(null, 'Checking…');
  try {
    const data = await request('/api/check', payload());
    elements.selectedMessage.textContent = data.selectedMessage; elements.printerStatus.textContent = data.status;
    elements.lastResult.textContent = 'Printer reachable'; setBadge(true, elements.useEmulator.checked ? 'Emulator connected' : 'Connected');
    await Promise.all([loadLogs(), elements.useEmulator.checked ? loadEmulator() : Promise.resolve()]);
  } catch (error) { elements.lastResult.textContent = 'Check failed'; setBadge(false, 'Offline / error'); showError(error.message); }
  finally { setBusy(false); }
}
async function setPrinter() {
  const body = payload(); elements.expectedMessage.textContent = body.messageName;
  setBusy(true); showError(''); setBadge(null, 'Updating…');
  try {
    const data = await request('/api/set', body);
    elements.selectedMessage.textContent = data.selectedMessage; elements.printerStatus.textContent = data.status;
    elements.lastResult.textContent = data.messageMatches ? 'Set and verified' : 'Message mismatch';
    setBadge(data.messageMatches, data.messageMatches ? 'Verified' : 'Mismatch');
    await Promise.all([loadLogs(), elements.useEmulator.checked ? loadEmulator() : Promise.resolve()]);
  } catch (error) { elements.lastResult.textContent = 'Set failed'; setBadge(false, 'Failed'); showError(error.message); await loadLogs(); }
  finally { setBusy(false); }
}
async function loadLogs() {
  const response = await fetch('/api/logs'); const logs = await response.json();
  if (!logs.length) { elements.logBody.innerHTML = '<tr><td colspan="6" class="muted">No commands yet.</td></tr>'; return; }
  elements.logBody.innerHTML = logs.map((log) => `<tr><td>${new Date(log.time).toLocaleString()}</td><td>${escapeHtml(log.action || '')}</td><td>${escapeHtml(log.selectedMessage || log.message || log.expectedMessage || '')}</td><td>${escapeHtml(log.fieldValue || '')}</td><td>${escapeHtml(log.status || '')}</td><td>${log.ok ? 'OK' : escapeHtml(log.error || 'Failed')}</td></tr>`).join('');
}
async function loadEmulator() {
  const response = await fetch('/api/emulator'); const state = await response.json();
  elements.emulatorMessage.value = state.selectedMessage; elements.emulatorStatus.value = state.status;
  elements.emulatorDelay.value = state.responseDelayMs; elements.emulatorEnabled.checked = state.enabled;
  elements.failNextCommand.checked = state.failNextCommand; elements.emulatorFields.textContent = JSON.stringify(state.userFields, null, 2);
}
async function saveEmulator() {
  showError('');
  try {
    await request('/api/emulator', { selectedMessage: elements.emulatorMessage.value, status: elements.emulatorStatus.value.trim(), responseDelayMs: Number(elements.emulatorDelay.value), enabled: elements.emulatorEnabled.checked, failNextCommand: elements.failNextCommand.checked });
    await loadEmulator();
  } catch (error) { showError(error.message); }
}
async function resetEmulator() { await request('/api/emulator/reset', {}); await loadEmulator(); }
function setMode(useEmulator) {
  if (useEmulator) {
    realPrinter = { ip: elements.ip.value.trim(), port: Number(elements.port.value) || 3100 };
    elements.ip.value = config.emulatorIp; elements.port.value = config.emulatorPort;
    elements.ip.disabled = true; elements.port.disabled = true; elements.emulatorPanel.classList.remove('hidden');
    elements.modeHelp.textContent = `Local emulator at ${config.emulatorIp}:${config.emulatorPort}`; loadEmulator();
  } else {
    elements.ip.disabled = false; elements.port.disabled = false; elements.ip.value = realPrinter.ip; elements.port.value = realPrinter.port;
    elements.emulatorPanel.classList.add('hidden'); elements.modeHelp.textContent = 'Real printer mode';
  }
  setBadge(null, 'Not checked');
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }

elements.checkButton.addEventListener('click', checkPrinter); elements.setButton.addEventListener('click', setPrinter);
elements.refreshLogs.addEventListener('click', loadLogs); elements.useEmulator.addEventListener('change', () => setMode(elements.useEmulator.checked));
elements.saveEmulator.addEventListener('click', saveEmulator); elements.resetEmulator.addEventListener('click', resetEmulator);

fetch('/api/config').then((r) => r.json()).then((value) => { config = value; elements.ip.value = config.printerIp; elements.port.value = config.printerPort; realPrinter = { ip: config.printerIp, port: config.printerPort }; }).finally(loadLogs);

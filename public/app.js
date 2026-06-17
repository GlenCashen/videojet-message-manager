const $ = (id) => document.getElementById(id);

const elements = {
  fleetBadge: $('fleetBadge'),
  checkAllButton: $('checkAllButton'),
  dashboardMessage: $('dashboardMessage'),
  coderGrid: $('coderGrid'),
  editorPanel: $('editorPanel'),
  editorSubtitle: $('editorSubtitle'),
  printerForm: $('printerForm'),
  printerId: $('printerId'),
  printerName: $('printerName'),
  printerLocation: $('printerLocation'),
  printerHost: $('printerHost'),
  printerPort: $('printerPort'),
  printerMode: $('printerMode'),
  printerEnabled: $('printerEnabled'),
  savePrinterButton: $('savePrinterButton'),
  cancelEditButton: $('cancelEditButton'),
  editorMessage: $('editorMessage'),
  ip: $('ip'),
  port: $('port'),
  messageName: $('messageName'),
  fieldName: $('fieldName'),
  fieldValue: $('fieldValue'),
  checkButton: $('checkButton'),
  setButton: $('setButton'),
  refreshLogs: $('refreshLogs'),
  expectedMessage: $('expectedMessage'),
  selectedMessage: $('selectedMessage'),
  printerStatus: $('printerStatus'),
  lastResult: $('lastResult'),
  errorBox: $('errorBox'),
  logBody: $('logBody'),
  useEmulator: $('useEmulator'),
  modeHelp: $('modeHelp'),
  emulatorPanel: $('emulatorPanel'),
  emulatorMessage: $('emulatorMessage'),
  emulatorStatus: $('emulatorStatus'),
  emulatorDelay: $('emulatorDelay'),
  emulatorEnabled: $('emulatorEnabled'),
  failNextCommand: $('failNextCommand'),
  saveEmulator: $('saveEmulator'),
  resetEmulator: $('resetEmulator'),
  emulatorFields: $('emulatorFields')
};

const state = {
  config: {},
  coders: {},
  order: [],
  editingId: null,
  checkingAll: false,
  realPrinter: { ip: '192.168.100.2', port: 3100 }
};

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function append(parent, ...children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return parent;
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === undefined) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  return append(node, children);
}

function setNotice(node, message = '', type = 'info') {
  node.textContent = message;
  node.className = `notice ${type}`;
  node.classList.toggle('hidden', !message);
}

function setFleetBadge(text, kind = 'neutral') {
  elements.fleetBadge.textContent = text;
  elements.fleetBadge.className = `badge ${kind}`;
}

function formatDate(value) {
  if (!value) return 'Not checked';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown' : date.toLocaleString();
}

function normalizeError(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'Unknown error');
}

async function apiJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw new Error(`Server unavailable: ${normalizeError(error)}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw new Error('Server returned a malformed API response.');
  }

  if (!response.ok) {
    throw new Error(data && data.error ? data.error : `Request failed (${response.status})`);
  }
  return data;
}

function setCoderFromConfig(printer) {
  const current = state.coders[printer.id] || {};
  const disabledState = printer.enabled ? 'not-checked' : 'disabled';
  state.coders[printer.id] = {
    ...current,
    config: printer,
    state: current.state && current.state !== 'disabled' ? current.state : disabledState,
    selectedMessage: current.selectedMessage || '-',
    status: current.status || '-',
    checkedAt: current.checkedAt || null,
    lastError: printer.enabled ? current.lastError || '' : 'Coder is disabled.',
    checking: false
  };
}

function applyCheckResult(result) {
  const id = result.id || result.printerId;
  if (!id || !state.coders[id]) return;

  const current = state.coders[id];
  state.coders[id] = {
    ...current,
    state: result.ok === false || result.online === false ? 'offline' : 'online',
    selectedMessage: result.selectedMessage || '-',
    status: result.status || '-',
    checkedAt: result.checkedAt || new Date().toISOString(),
    lastError: result.ok === false ? result.error || 'Check failed.' : '',
    checking: false
  };
}

function applyCheckError(id, error) {
  if (!state.coders[id]) return;
  state.coders[id] = {
    ...state.coders[id],
    state: 'offline',
    selectedMessage: '-',
    status: '-',
    checkedAt: new Date().toISOString(),
    lastError: normalizeError(error),
    checking: false
  };
}

function statusLabel(coder) {
  if (coder.checking) return 'Checking';
  if (!coder.config.enabled) return 'Disabled';
  if (coder.state === 'online') return 'Online';
  if (coder.state === 'offline') return 'Offline';
  return 'Not checked';
}

function cardClass(coder) {
  if (!coder.config.enabled) return 'coder-card is-disabled';
  if (coder.checking) return 'coder-card is-checking';
  if (coder.state === 'online') return 'coder-card is-online';
  if (coder.state === 'offline') return 'coder-card is-offline';
  return 'coder-card is-new';
}

function detail(label, value) {
  return el('div', { className: 'detail' }, [
    el('span', { text: label }),
    el('strong', { text: value || '-' })
  ]);
}

function createCoderCard(coder) {
  const printer = coder.config;
  const checkButton = el('button', {
    className: 'secondary',
    type: 'button',
    'data-action': 'check',
    'data-id': printer.id
  }, 'Check');
  checkButton.disabled = !printer.enabled || coder.checking || state.checkingAll;

  const editButton = el('button', {
    className: 'ghost bordered',
    type: 'button',
    'data-action': 'edit',
    'data-id': printer.id
  }, 'Edit');

  const message = coder.lastError
    ? el('p', { className: 'card-error', text: coder.lastError })
    : null;

  return el('article', { className: cardClass(coder), dataset: { id: printer.id } }, [
    el('div', { className: 'card-top' }, [
      el('div', {}, [
        el('h3', { text: printer.name }),
        el('p', { className: 'muted', text: printer.location || 'No location set' })
      ]),
      el('span', { className: 'status-pill', text: statusLabel(coder) })
    ]),
    el('div', { className: 'coder-meta' }, [
      detail('Host', `${printer.host}:${printer.port}`),
      detail('Mode', printer.mode === 'emulator' ? 'Emulator' : 'Real printer'),
      detail('Enabled', printer.enabled ? 'Enabled' : 'Disabled'),
      detail('Selected message', coder.selectedMessage),
      detail('Printer status', coder.status),
      detail('Last checked', formatDate(coder.checkedAt))
    ]),
    message,
    el('div', { className: 'card-actions' }, [checkButton, editButton])
  ]);
}

function renderDashboard() {
  clear(elements.coderGrid);

  if (!state.order.length) {
    elements.coderGrid.appendChild(el('article', { className: 'coder-card empty' }, [
      el('h3', { text: 'No coders configured' }),
      el('p', { className: 'muted', text: 'Add up to three coders in data/printers.json.' })
    ]));
  } else {
    for (const id of state.order) elements.coderGrid.appendChild(createCoderCard(state.coders[id]));
  }

  const coders = state.order.map((id) => state.coders[id]);
  const enabled = coders.filter((coder) => coder.config.enabled);
  const online = enabled.filter((coder) => coder.state === 'online').length;
  const offline = enabled.filter((coder) => coder.state === 'offline').length;

  if (!coders.length) setFleetBadge('No coders', 'neutral');
  else if (offline) setFleetBadge(`${offline} offline`, 'bad');
  else if (online && online === enabled.length) setFleetBadge('All enabled online', 'good');
  else setFleetBadge(`${enabled.length} enabled`, 'neutral');

  elements.checkAllButton.disabled = state.checkingAll || enabled.length === 0;
}

async function loadPrinters() {
  setNotice(elements.dashboardMessage, 'Loading coder configuration...');
  try {
    const printers = await apiJson('/api/printers');
    if (!Array.isArray(printers)) throw new Error('Printer configuration response was not an array.');
    if (printers.length > 3) throw new Error('Only three coders are supported.');

    const nextIds = printers.map((printer) => printer.id);
    for (const printer of printers) setCoderFromConfig(printer);
    for (const id of Object.keys(state.coders)) {
      if (!nextIds.includes(id)) delete state.coders[id];
    }
    state.order = nextIds;
    setNotice(elements.dashboardMessage);
  } catch (error) {
    setNotice(elements.dashboardMessage, normalizeError(error), 'error');
    setFleetBadge('Config error', 'bad');
  }
  renderDashboard();
}

async function checkCoder(id) {
  const coder = state.coders[id];
  if (!coder) return;
  if (!coder.config.enabled) {
    state.coders[id] = { ...coder, state: 'disabled', lastError: 'Coder is disabled.' };
    renderDashboard();
    return;
  }

  state.coders[id] = { ...coder, checking: true, lastError: '' };
  renderDashboard();
  try {
    const result = await apiJson(`/api/printers/${encodeURIComponent(id)}/check`, { method: 'POST', body: {} });
    applyCheckResult(result);
    setNotice(elements.dashboardMessage, `${state.coders[id].config.name} checked successfully.`, 'success');
    await loadLogs();
  } catch (error) {
    applyCheckError(id, error);
    setNotice(elements.dashboardMessage, `${coder.config.name} check failed.`, 'error');
    await loadLogs();
  }
  renderDashboard();
}

async function checkAllCoders() {
  state.checkingAll = true;
  setNotice(elements.dashboardMessage, 'Checking enabled coders...');
  for (const id of state.order) {
    const coder = state.coders[id];
    if (coder.config.enabled) state.coders[id] = { ...coder, checking: true, lastError: '' };
  }
  renderDashboard();

  try {
    const data = await apiJson('/api/printers/check-all', { method: 'POST', body: {} });
    if (!Array.isArray(data.results)) throw new Error('Check-all response did not include result rows.');
    for (const result of data.results) applyCheckResult(result);
    const failed = data.results.filter((result) => result.ok === false).length;
    setNotice(
      elements.dashboardMessage,
      failed ? `Check all finished with ${failed} failure${failed === 1 ? '' : 's'}.` : 'All enabled coders checked successfully.',
      failed ? 'error' : 'success'
    );
    await loadLogs();
  } catch (error) {
    for (const id of state.order) {
      if (state.coders[id].checking) applyCheckError(id, error);
    }
    setNotice(elements.dashboardMessage, normalizeError(error), 'error');
    await loadLogs();
  } finally {
    state.checkingAll = false;
    for (const id of state.order) state.coders[id].checking = false;
    renderDashboard();
  }
}

function startEdit(id) {
  const coder = state.coders[id];
  if (!coder) return;
  const printer = coder.config;
  state.editingId = id;
  elements.printerId.value = id;
  elements.printerName.value = printer.name;
  elements.printerLocation.value = printer.location || '';
  elements.printerHost.value = printer.host;
  elements.printerPort.value = printer.port;
  elements.printerMode.value = printer.mode;
  elements.printerEnabled.checked = printer.enabled;
  elements.editorSubtitle.textContent = `Editing ${printer.name}`;
  setNotice(elements.editorMessage);
  elements.editorPanel.classList.remove('hidden');
  elements.printerName.focus();
}

function closeEditor() {
  state.editingId = null;
  elements.printerForm.reset();
  setNotice(elements.editorMessage);
  elements.editorPanel.classList.add('hidden');
}

async function savePrinter(event) {
  event.preventDefault();
  const id = elements.printerId.value;
  if (!id || !state.coders[id]) return;

  elements.savePrinterButton.disabled = true;
  setNotice(elements.editorMessage, 'Saving coder...');
  try {
    const data = await apiJson(`/api/printers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        name: elements.printerName.value.trim(),
        location: elements.printerLocation.value.trim(),
        host: elements.printerHost.value.trim(),
        port: Number(elements.printerPort.value),
        enabled: elements.printerEnabled.checked,
        mode: elements.printerMode.value
      }
    });

    if (!data || data.ok !== true || !data.printer) throw new Error('Save response did not include the updated coder.');
    await loadPrinters();
    startEdit(id);
    setNotice(elements.editorMessage, `${data.printer.name} saved.`, 'success');
  } catch (error) {
    setNotice(elements.editorMessage, normalizeError(error), 'error');
  } finally {
    elements.savePrinterButton.disabled = false;
  }
}

function singlePrinterPayload() {
  return {
    ip: elements.ip.value.trim(),
    port: Number(elements.port.value),
    messageName: elements.messageName.value,
    fieldName: elements.fieldName.value.trim(),
    fieldValue: elements.fieldValue.value
  };
}

function setSinglePrinterBusy(busy) {
  elements.checkButton.disabled = busy;
  elements.setButton.disabled = busy;
}

function showSinglePrinterError(message = '') {
  elements.errorBox.textContent = message;
  elements.errorBox.classList.toggle('hidden', !message);
}

async function postJson(url, body) {
  return apiJson(url, { method: 'POST', body });
}

async function checkSinglePrinter() {
  setSinglePrinterBusy(true);
  showSinglePrinterError('');
  elements.lastResult.textContent = 'Checking...';
  try {
    const data = await postJson('/api/check', singlePrinterPayload());
    elements.selectedMessage.textContent = data.selectedMessage || '-';
    elements.printerStatus.textContent = data.status || '-';
    elements.lastResult.textContent = 'Printer reachable';
    await Promise.all([loadLogs(), elements.useEmulator.checked ? loadEmulator() : Promise.resolve()]);
  } catch (error) {
    elements.lastResult.textContent = 'Check failed';
    showSinglePrinterError(normalizeError(error));
    await loadLogs();
  } finally {
    setSinglePrinterBusy(false);
  }
}

async function setSinglePrinter() {
  const body = singlePrinterPayload();
  elements.expectedMessage.textContent = body.messageName;
  setSinglePrinterBusy(true);
  showSinglePrinterError('');
  elements.lastResult.textContent = 'Updating...';
  try {
    const data = await postJson('/api/set', body);
    elements.selectedMessage.textContent = data.selectedMessage || '-';
    elements.printerStatus.textContent = data.status || '-';
    elements.lastResult.textContent = data.messageMatches ? 'Set and verified' : 'Message mismatch';
    await Promise.all([loadLogs(), elements.useEmulator.checked ? loadEmulator() : Promise.resolve()]);
  } catch (error) {
    elements.lastResult.textContent = 'Set failed';
    showSinglePrinterError(normalizeError(error));
    await loadLogs();
  } finally {
    setSinglePrinterBusy(false);
  }
}

function addCell(row, value, className = '') {
  row.appendChild(el('td', { className, text: value || '' }));
}

async function loadLogs() {
  try {
    const logs = await apiJson('/api/logs');
    clear(elements.logBody);
    if (!Array.isArray(logs) || !logs.length) {
      const row = el('tr');
      row.appendChild(el('td', { colspan: '7', className: 'muted', text: 'No commands yet.' }));
      elements.logBody.appendChild(row);
      return;
    }

    for (const log of logs) {
      const row = el('tr');
      addCell(row, formatDate(log.time));
      addCell(row, log.action || '');
      addCell(row, log.printerId || '');
      addCell(row, log.selectedMessage || log.message || log.expectedMessage || '');
      addCell(row, log.fieldValue || '');
      addCell(row, log.status || '');
      addCell(row, log.ok ? 'OK' : log.error || 'Failed', log.ok ? 'result-ok' : 'result-bad');
      elements.logBody.appendChild(row);
    }
  } catch (error) {
    clear(elements.logBody);
    const row = el('tr');
    row.appendChild(el('td', { colspan: '7', className: 'error-cell', text: normalizeError(error) }));
    elements.logBody.appendChild(row);
  }
}

async function loadEmulator() {
  const emulator = await apiJson('/api/emulator');
  elements.emulatorMessage.value = emulator.selectedMessage;
  elements.emulatorStatus.value = emulator.status;
  elements.emulatorDelay.value = emulator.responseDelayMs;
  elements.emulatorEnabled.checked = emulator.enabled;
  elements.failNextCommand.checked = emulator.failNextCommand;
  elements.emulatorFields.textContent = JSON.stringify(emulator.userFields || {}, null, 2);
}

async function saveEmulator() {
  showSinglePrinterError('');
  try {
    await postJson('/api/emulator', {
      selectedMessage: elements.emulatorMessage.value,
      status: elements.emulatorStatus.value.trim(),
      responseDelayMs: Number(elements.emulatorDelay.value),
      enabled: elements.emulatorEnabled.checked,
      failNextCommand: elements.failNextCommand.checked
    });
    await loadEmulator();
  } catch (error) {
    showSinglePrinterError(normalizeError(error));
  }
}

async function resetEmulator() {
  showSinglePrinterError('');
  try {
    await postJson('/api/emulator/reset', {});
    await loadEmulator();
  } catch (error) {
    showSinglePrinterError(normalizeError(error));
  }
}

function setMode(useEmulator) {
  if (useEmulator) {
    state.realPrinter = { ip: elements.ip.value.trim(), port: Number(elements.port.value) || 3100 };
    elements.ip.value = state.config.emulatorIp;
    elements.port.value = state.config.emulatorPort;
    elements.ip.disabled = true;
    elements.port.disabled = true;
    elements.emulatorPanel.classList.remove('hidden');
    elements.modeHelp.textContent = `Local emulator at ${state.config.emulatorIp}:${state.config.emulatorPort}`;
    loadEmulator().catch((error) => showSinglePrinterError(normalizeError(error)));
  } else {
    elements.ip.disabled = false;
    elements.port.disabled = false;
    elements.ip.value = state.realPrinter.ip;
    elements.port.value = state.realPrinter.port;
    elements.emulatorPanel.classList.add('hidden');
    elements.modeHelp.textContent = 'Real printer mode';
  }
}

async function loadConfig() {
  try {
    state.config = await apiJson('/api/config');
    elements.ip.value = state.config.printerIp;
    elements.port.value = state.config.printerPort;
    state.realPrinter = { ip: state.config.printerIp, port: state.config.printerPort };
  } catch (error) {
    showSinglePrinterError(normalizeError(error));
  }
}

elements.coderGrid.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'check') checkCoder(id);
  if (action === 'edit') startEdit(id);
});
elements.checkAllButton.addEventListener('click', checkAllCoders);
elements.printerForm.addEventListener('submit', savePrinter);
elements.cancelEditButton.addEventListener('click', closeEditor);
elements.checkButton.addEventListener('click', checkSinglePrinter);
elements.setButton.addEventListener('click', setSinglePrinter);
elements.refreshLogs.addEventListener('click', loadLogs);
elements.useEmulator.addEventListener('change', () => setMode(elements.useEmulator.checked));
elements.saveEmulator.addEventListener('click', saveEmulator);
elements.resetEmulator.addEventListener('click', resetEmulator);

Promise.all([loadConfig(), loadPrinters(), loadLogs()]);

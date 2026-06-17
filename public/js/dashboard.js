import { apiJson } from './api.js';
import { clear, el, formatDate, normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';
import { state } from './state.js';

let dashboardCallbacks = {
  loadLogs: async () => { },
  startEdit: () => { }
};
const STALE_AFTER_MS = 45000;

function setFleetBadge(text, kind = 'neutral') {
  elements.fleetBadge.textContent = text;
  elements.fleetBadge.className = `badge ${kind}`;
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
    rawStatus: current.rawStatus || null,
    decodedStatus: current.decodedStatus || null,
    lastSuccessfulAt: current.lastSuccessfulAt || null,
    consecutiveFailures: current.consecutiveFailures || 0,
    revision: current.revision || 0,
    busy: current.busy || false,
    currentOperation: current.currentOperation || null,
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
    status: result.rawStatus || result.status || '-',
    rawStatus: result.rawStatus || result.status || null,
    decodedStatus: result.decodedStatus || null,
    lastSuccessfulAt: result.lastSuccessfulAt || result.checkedAt || current.lastSuccessfulAt,
    consecutiveFailures: result.consecutiveFailures ?? current.consecutiveFailures ?? 0,
    revision: result.revision ?? current.revision ?? 0,
    busy: Boolean(result.busy),
    stale: Boolean(result.stale),
    currentOperation: result.currentOperation || null,
    checkedAt: result.lastAttemptAt || result.checkedAt || new Date().toISOString(),
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
  const stale = isStale(coder);
  const visibleBusy =
    Boolean(coder.busy) &&
    coder.currentOperation !== 'poll';

  if (visibleBusy || coder.checking) {
    return coder.currentOperation
      ? `Busy: ${coder.currentOperation}`
      : 'Busy';
  }

  if (!coder.config.enabled) return 'Disabled';
  if (coder.state === 'online') return stale ? 'Online / stale' : 'Online';
  if (coder.state === 'offline') return stale ? 'Offline / stale' : 'Offline';
  if (stale) return 'Data stale';

  return 'Not checked';
}

function cardClass(coder) {
  if (!coder.config.enabled) return 'coder-card is-disabled';
  if (coder.checking) return 'coder-card is-checking';
  if (isStale(coder) && coder.state !== 'offline') return 'coder-card is-stale';
  if (coder.state === 'online') return 'coder-card is-online';
  if (coder.state === 'offline') return 'coder-card is-offline';
  return 'coder-card is-new';
}

function isStale(coder) {
  if (typeof coder.stale === 'boolean') return coder.stale;
  if (!coder.lastSuccessfulAt) return false;
  const checkedAt = new Date(coder.lastSuccessfulAt).valueOf();
  return Number.isFinite(checkedAt) && Date.now() - checkedAt > STALE_AFTER_MS;
}

function detail(label, value) {
  return el('div', { className: 'detail' }, [
    el('span', { text: label }),
    el('strong', { text: value || '-' })
  ]);
}

function alarmText(decodedStatus) {
  if (!decodedStatus?.valid) return '-';
  return decodedStatus.alarm?.label || '-';
}

function faultText(decodedStatus) {
  if (!decodedStatus?.valid) return decodedStatus?.error || '-';
  return decodedStatus.faults.length ? decodedStatus.faults.map((fault) => fault.label).join(', ') : 'None';
}

function createCoderCard(coder) {
  const printer = coder.config;

  const visibleBusy =
    Boolean(coder.busy) &&
    coder.currentOperation !== 'poll';

  const checkButton = el('button', {
    className: 'secondary',
    type: 'button',
    'data-action': 'check',
    'data-id': printer.id
  }, 'Check');

  checkButton.disabled =
    !printer.enabled ||
    visibleBusy ||
    coder.checking ||
    state.checkingAll;
    
  const editButton = el('button', {
    className: 'ghost bordered',
    type: 'button',
    'data-action': 'edit',
    'data-id': printer.id
  }, 'Edit');
  const openLink = el('a', {
    className: 'secondary button-link',
    href: `/printer.html?id=${encodeURIComponent(printer.id)}`
  }, 'Open');

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
      detail('Alarm', alarmText(coder.decodedStatus)),
      detail('Faults', faultText(coder.decodedStatus)),
      detail('Raw status', coder.rawStatus || coder.status),
      detail('Last success', formatDate(coder.lastSuccessfulAt)),
      detail('Failures', String(coder.consecutiveFailures || 0)),
      detail('Revision', String(coder.revision || 0))
    ]),
    message,
    el('div', { className: 'card-actions' }, [checkButton, openLink, editButton])
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
  const stale = enabled.filter(isStale).length;

  if (!coders.length) setFleetBadge('No coders', 'neutral');
  else if (offline) setFleetBadge(`${offline} offline`, 'bad');
  else if (stale) setFleetBadge(`${stale} stale`, 'stale');
  else if (online && online === enabled.length) setFleetBadge('All enabled online', 'good');
  else setFleetBadge(`${enabled.length} enabled`, 'neutral');

  elements.checkAllButton.disabled = state.checkingAll || enabled.length === 0;
}

async function loadPrinters() {
  setNotice(elements.dashboardMessage, 'Loading coder configuration...');
  try {
    const printers = await apiJson('/api/printers');
    applyFleetSnapshot(printers);
    setNotice(elements.dashboardMessage);
  } catch (error) {
    setNotice(elements.dashboardMessage, normalizeError(error), 'error');
    setFleetBadge('Config error', 'bad');
  }
  renderDashboard();
}

async function loadStatuses() {
  const statuses = await apiJson('/api/printers/status');
  applyStatusSnapshot(statuses);
}

function applyFleetSnapshot(printers) {
  if (!Array.isArray(printers)) throw new Error('Printer configuration response was not an array.');
  if (printers.length > 3) throw new Error('Only three coders are supported.');

  const nextIds = printers.map((printer) => printer.id);
  for (const printer of printers) setCoderFromConfig(printer);
  for (const id of Object.keys(state.coders)) {
    if (!nextIds.includes(id)) delete state.coders[id];
  }
  state.order = nextIds;
  renderDashboard();
}

function applyStatusSnapshot(statuses) {
  if (!Array.isArray(statuses)) return;
  for (const status of statuses) applyCheckResult(status);
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
    await dashboardCallbacks.loadLogs();
  } catch (error) {
    applyCheckError(id, error);
    setNotice(elements.dashboardMessage, `${coder.config.name} check failed.`, 'error');
    await dashboardCallbacks.loadLogs();
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
    await dashboardCallbacks.loadLogs();
  } catch (error) {
    for (const id of state.order) {
      if (state.coders[id].checking) applyCheckError(id, error);
    }
    setNotice(elements.dashboardMessage, normalizeError(error), 'error');
    await dashboardCallbacks.loadLogs();
  } finally {
    state.checkingAll = false;
    for (const id of state.order) state.coders[id].checking = false;
    renderDashboard();
  }
}

function applyPrinterEvent(payload) {
  applyCheckResult(payload);
  renderDashboard();
}

function applyPrinterConfig(printer) {
  setCoderFromConfig(printer);
  if (!state.order.includes(printer.id)) state.order.push(printer.id);
  renderDashboard();
}

function setupDashboard(callbacks) {
  dashboardCallbacks = { ...dashboardCallbacks, ...callbacks };
  elements.coderGrid.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === 'check') checkCoder(id);
    if (action === 'edit') dashboardCallbacks.startEdit(id);
  });
  elements.checkAllButton.addEventListener('click', checkAllCoders);
  setInterval(renderDashboard, 10000);
}

export { applyFleetSnapshot, applyPrinterConfig, applyPrinterEvent, applyStatusSnapshot, loadPrinters, loadStatuses, renderDashboard, setupDashboard };

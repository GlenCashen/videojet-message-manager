import { apiJson } from './api.js';
import { clear, el, formatDate, normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';
import { state } from './state.js';
import {
  alarmSummary,
  faultSummary,
  formatAge,
  isStale,
  isVisibleBusy,
  statusLabel,
  statusTimestamp,
  statusTone
} from './status-ui.js';

let dashboardCallbacks = {
  loadLogs: async () => { },
  startEdit: () => { }
};

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
    busy: isVisibleBusy(current),
    currentOperation: isVisibleBusy(current) ? current.currentOperation || null : null,
    checkedAt: current.checkedAt || null,
    stale: current.stale || false,
    lastError: printer.enabled ? current.lastError || '' : 'Coder is disabled.',
    checking: false
  };
}

function applyCheckResult(result) {
  const id = result.id || result.printerId;
  if (!id || !state.coders[id]) return;

  const current = state.coders[id];
  const visibleBusy = isVisibleBusy(result);

  state.coders[id] = {
    ...current,
    state: result.ok === false || result.online === false ? 'offline' : 'online',
    selectedMessage: result.selectedMessage || current.selectedMessage || '-',
    status: result.rawStatus || result.status || current.status || '-',
    rawStatus: result.rawStatus || result.status || current.rawStatus || null,
    decodedStatus: result.decodedStatus || current.decodedStatus || null,
    lastSuccessfulAt: result.lastSuccessfulAt || result.checkedAt || current.lastSuccessfulAt,
    consecutiveFailures: result.consecutiveFailures ?? current.consecutiveFailures ?? 0,
    revision: result.revision ?? current.revision ?? 0,
    busy: visibleBusy,
    stale: Boolean(result.stale),
    currentOperation: visibleBusy ? result.currentOperation || null : null,
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
    checkedAt: new Date().toISOString(),
    lastError: normalizeError(error),
    checking: false
  };
}

function cardClass(coder) {
  const checkingClass = coder.checking ? ' is-checking' : '';
  return `coder-card status-${statusTone(coder)}${checkingClass}`;
}

function detail(label, value) {
  return el('div', { className: 'detail' }, [
    el('span', { text: label }),
    el('strong', { text: value || '-' })
  ]);
}

function metric(label, value) {
  return el('div', { className: 'status-metric' }, [
    el('span', { text: label }),
    el('strong', { text: value || '-' })
  ]);
}

function createCoderCard(coder) {
  const printer = coder.config;
  const visibleBusy = isVisibleBusy(coder);
  const commandDisabled =
    !printer.enabled ||
    !state.serverConnected ||
    visibleBusy ||
    coder.checking ||
    state.checkingAll;
  const href = `/printer.html?id=${encodeURIComponent(printer.id)}`;
  const timestamp = statusTimestamp(coder);
  const liveText = state.serverConnected ? 'Live data stream' : 'Last known status';
  const statusText = coder.checking ? 'Checking' : statusLabel(coder);

  const checkButton = el('button', {
    className: 'secondary',
    type: 'button',
    'data-action': 'check',
    'data-id': printer.id
  }, 'Check');
  checkButton.disabled = commandDisabled;

  const openLink = el('a', {
    className: 'card-open-link',
    href
  }, 'Open coder');

  const editButton = el('button', {
    className: 'ghost bordered',
    type: 'button',
    'data-action': 'edit',
    'data-id': printer.id
  }, 'Edit');

  const message = coder.lastError
    ? el('p', { className: 'card-error', text: coder.lastError })
    : null;

  return el('article', {
    className: cardClass(coder),
    tabindex: '0',
    role: 'link',
    'aria-label': `Open ${printer.name}`,
    dataset: {
      id: printer.id,
      action: 'open',
      href
    }
  }, [
    el('div', { className: 'card-top' }, [
      el('div', {}, [
        el('h3', { text: printer.name }),
        el('p', { className: 'muted', text: printer.location || 'No location set' })
      ]),
      el('div', { className: 'status-cluster' }, [
        el('span', { className: 'status-light', 'aria-hidden': 'true' }),
        el('span', { className: 'status-word', text: statusText })
      ])
    ]),
    el('div', { className: 'operator-metrics' }, [
      metric('Selected message', coder.selectedMessage),
      metric('Fault summary', faultSummary(coder.decodedStatus)),
      metric('Last successful update', formatAge(coder.lastSuccessfulAt)),
      metric('Data source', liveText)
    ]),
    message,
    el('details', { className: 'diagnostics' }, [
      el('summary', {}, 'Diagnostics'),
      el('div', { className: 'coder-meta' }, [
        detail('Host', `${printer.host}:${printer.port}`),
        detail('Mode', printer.mode === 'emulator' ? 'Emulator' : 'Real printer'),
        detail('Enabled', printer.enabled ? 'Enabled' : 'Disabled'),
        detail('Connection state', coder.state || 'not-checked'),
        detail('Alarm', alarmSummary(coder.decodedStatus)),
        detail('Raw status', coder.rawStatus || coder.status),
        detail('Last success', formatDate(coder.lastSuccessfulAt)),
        detail('Last attempt', formatDate(timestamp)),
        detail('Failures', String(coder.consecutiveFailures || 0)),
        detail('Revision', String(coder.revision || 0))
      ])
    ]),
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
  const online = enabled.filter((coder) => coder.state === 'online' && !isStale(coder)).length;
  const offline = enabled.filter((coder) => coder.state === 'offline').length;
  const stale = enabled.filter(isStale).length;
  const unknown = enabled.filter((coder) => coder.state === 'not-checked').length;

  if (!coders.length) setFleetBadge('No coders', 'neutral');
  else if (offline) setFleetBadge(`${offline} offline`, 'bad');
  else if (stale) setFleetBadge(`${stale} warning`, 'stale');
  else if (online && online === enabled.length) setFleetBadge('All enabled healthy', 'good');
  else setFleetBadge(`${enabled.length} enabled`, 'neutral');

  if (elements.fleetSummary) {
    elements.fleetSummary.textContent =
      `${enabled.length} enabled · ${online} healthy · ${stale} warning · ${offline} offline · ${unknown} not checked`;
  }

  elements.checkAllButton.disabled = state.checkingAll || enabled.length === 0 || !state.serverConnected;
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
  if (!coder || !state.serverConnected) return;
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
  if (!state.serverConnected) return;

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
  if (payload?.currentOperation === 'poll' && payload.busy) return;
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
    if (button) {
      const { action, id } = button.dataset;
      if (action === 'check') checkCoder(id);
      if (action === 'edit') dashboardCallbacks.startEdit(id);
      return;
    }

    if (event.target.closest('a, summary, details')) return;
    const card = event.target.closest('[data-action="open"]');
    if (card?.dataset.href) window.location.href = card.dataset.href;
  });

  elements.coderGrid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('[data-action="open"]');
    if (!card?.dataset.href) return;

    event.preventDefault();
    window.location.href = card.dataset.href;
  });

  elements.checkAllButton.addEventListener('click', checkAllCoders);
  setInterval(renderDashboard, 10000);
}

export {
  applyFleetSnapshot,
  applyPrinterConfig,
  applyPrinterEvent,
  applyStatusSnapshot,
  loadPrinters,
  loadStatuses,
  renderDashboard,
  setupDashboard
};

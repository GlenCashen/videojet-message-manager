import { apiJson } from './api.js';
import { clear, el, formatDate, normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';
import { printerHref } from './navigation.js';
import { canOperatePrinter, hasCapability } from './session.js';
import { state } from './state.js';
import {
  alarmSummary,
  compactFaultLines,
  faultCountLabel,
  faultSummary,
  formatAge,
  isStale,
  isVisibleBusy,
  printerState,
  statusLabel,
  statusTimestamp,
  statusTone,
  trafficLightMarkup
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
    messageVerification: printer.capabilities?.currentMessageReadback === false
      ? 'unsupported'
      : current.messageVerification || null,
    status: current.status || '-',
    rawStatus: current.rawStatus || null,
    decodedStatus: current.decodedStatus || null,
    expectedOutput: current.expectedOutput || null,
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
    messageVerification: result.messageVerification || current.messageVerification || null,
    status: result.rawStatus || result.status || current.status || '-',
    rawStatus: result.rawStatus || result.status || current.rawStatus || null,
    decodedStatus: result.decodedStatus || current.decodedStatus || null,
    expectedOutput: result.expectedOutput || current.expectedOutput || null,
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

function keyedDetail(key, label, value) {
  return el('div', { className: 'detail' }, [
    el('span', { text: label }),
    el('strong', { text: value || '-', dataset: { field: key } })
  ]);
}

function metric(key, label, value) {
  return el('div', { className: 'status-metric' }, [
    el('span', { text: label }),
    el('strong', { text: value || '-', dataset: { field: key } })
  ]);
}

function expectedOutputText(expectedOutput) {
  if (!expectedOutput?.rendered) return 'No expected output recorded';
  return expectedOutput.rendered;
}

function faultHeading(coder) {
  return coder.state === 'offline' ? 'Last known active faults' : 'Active faults';
}

function alarmHeading(coder) {
  return coder.state === 'offline' ? 'Last known printer status' : 'Printer status';
}

function cardValues(coder) {
  const printer = coder.config;
  const visibleBusy = isVisibleBusy(coder);
  const timestamp = statusTimestamp(coder);

  const printerLight = printerState(coder.decodedStatus);
  return {
    href: printerHref(printer.id),
    statusText: coder.checking ? 'Checking' : statusLabel(coder),
    name: printer.name,
    location: printer.location || 'No location set',
    selectedMessage: coder.messageVerification === 'unsupported' ? 'Readback unavailable' : coder.selectedMessage,
    expectedOutput: expectedOutputText(coder.expectedOutput),
    expectedOutputLabel: coder.expectedOutput?.source === 'last-known' ? 'Last expected output' : 'Expected print',
    faultHeading: faultHeading(coder),
    alarmHeading: alarmHeading(coder),
    faultSummary: faultSummary(coder.decodedStatus),
    faultCount: faultCountLabel(coder.decodedStatus),
    faultLines: compactFaultLines(coder.decodedStatus),
    lastSuccessAge: formatAge(coder.lastSuccessfulAt),
    dataSource: state.serverConnected ? 'Live data stream' : 'Last known status',
    host: `${printer.host}:${printer.port}`,
    mode: printer.mode === 'emulator' ? 'Emulator' : 'Real printer',
    model: `Videojet ${printer.model || '1620'}`,
    enabled: printer.enabled ? 'Enabled' : 'Disabled',
    connectionState: coder.state || 'not-checked',
    alarm: alarmSummary(coder.decodedStatus),
    printerState: printerLight.label,
    printerStateSuffix: isStale(coder) ? 'Last known printer state' : 'Printer state',
    rawStatus: coder.rawStatus || coder.status,
    lastSuccessDate: formatDate(coder.lastSuccessfulAt),
    lastAttemptDate: formatDate(timestamp),
    failures: String(coder.consecutiveFailures || 0),
    revision: String(coder.revision || 0),
    commandDisabled:
      !printer.enabled ||
      !state.serverConnected ||
      !canOperatePrinter(printer.id) ||
      visibleBusy ||
      coder.checking ||
      state.checkingAll
  };
}

function updateTrafficLight(container, coder) {
  if (!container) return;
  clear(container);
  container.appendChild(trafficLightMarkup(coder.decodedStatus, { stale: isStale(coder) || coder.state === 'offline' }));
}

function updateFaultList(card, coder) {
  const list = card.querySelector('[data-field="faultList"]');
  if (!list) return;
  clear(list);
  const lines = compactFaultLines(coder.decodedStatus);
  for (const line of lines) list.appendChild(el('li', { text: line }));
}

function setField(card, field, value) {
  const target = card.querySelector(`[data-field="${field}"]`);
  if (target) target.textContent = value || '-';
}

function updateCardError(card, coder) {
  const existing = card.querySelector('.card-error');
  if (!coder.lastError) {
    existing?.remove();
    return;
  }

  if (existing) {
    existing.textContent = coder.lastError;
    return;
  }

  const diagnostics = card.querySelector('.diagnostics');
  const message = el('p', { className: 'card-error', text: coder.lastError });
  card.insertBefore(message, diagnostics);
}

function updateCoderCard(card, coder) {
  const values = cardValues(coder);
  const printer = coder.config;

  card.className = cardClass(coder);
  card.setAttribute('aria-label', `Open ${printer.name}`);
  card.dataset.id = printer.id;
  card.dataset.href = values.href;

  for (const [field, value] of Object.entries(values)) {
    if (!['href', 'commandDisabled', 'faultLines'].includes(field)) setField(card, field, value);
  }
  updateFaultList(card, coder);
  updateTrafficLight(card.querySelector('[data-field="trafficLight"]'), coder);

  const checkButton = card.querySelector('button[data-action="check"]');
  if (checkButton) {
    checkButton.dataset.id = printer.id;
    checkButton.disabled = values.commandDisabled;
  }

  const editButton = card.querySelector('button[data-action="edit"]');
  if (editButton) editButton.dataset.id = printer.id;

  const openLink = card.querySelector('.card-open-link');
  if (openLink) openLink.href = values.href;

  updateCardError(card, coder);
}

function createCoderCard(coder) {
  const printer = coder.config;
  const values = cardValues(coder);

  const checkButton = el('button', {
    className: 'secondary',
    type: 'button',
    'data-action': 'check',
    'data-id': printer.id
  }, 'Check');
  checkButton.disabled = values.commandDisabled;

  const openLink = el('a', {
    className: 'card-open-link',
    href: values.href
  }, 'Open coder');

  const editButton = hasCapability('configurePrinters')
    ? el('button', {
      className: 'ghost bordered',
      type: 'button',
      'data-action': 'edit',
      'data-id': printer.id
    }, 'Edit')
    : null;

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
      href: values.href
    }
  }, [
    el('div', { className: 'card-top' }, [
      el('div', {}, [
        el('h3', { text: printer.name, dataset: { field: 'name' } }),
        el('p', { className: 'muted', text: values.location, dataset: { field: 'location' } })
      ]),
      el('div', { className: 'status-cluster' }, [
        el('span', { className: 'status-light', 'aria-hidden': 'true' }),
        el('span', { className: 'status-word', text: values.statusText, dataset: { field: 'statusText' } })
      ])
    ]),
    el('div', { className: 'operator-metrics' }, [
      metric('selectedMessage', 'Selected message', values.selectedMessage),
      el('div', { className: 'status-metric traffic-status' }, [
        el('span', { text: values.printerStateSuffix, dataset: { field: 'printerStateSuffix' } }),
        el('div', { className: 'traffic-light-slot', dataset: { field: 'trafficLight' } }, [
          trafficLightMarkup(coder.decodedStatus, { stale: isStale(coder) || coder.state === 'offline' })
        ]),
        el('strong', { text: values.printerState, dataset: { field: 'printerState' } })
      ]),
      el('div', { className: 'status-metric expected-print' }, [
        el('span', { text: values.expectedOutputLabel, dataset: { field: 'expectedOutputLabel' } }),
        el('pre', { text: values.expectedOutput, dataset: { field: 'expectedOutput' } })
      ]),
      el('div', { className: 'status-metric' }, [
        el('span', { text: values.faultHeading, dataset: { field: 'faultHeading' } }),
        el('strong', { text: values.faultCount, dataset: { field: 'faultCount' } }),
        el('ul', { className: 'fault-list', dataset: { field: 'faultList' } },
          values.faultLines.map((line) => el('li', { text: line })))
      ]),
      metric('lastSuccessAge', 'Last successful update', values.lastSuccessAge),
      metric('dataSource', 'Data source', values.dataSource)
    ]),
    message,
    (hasCapability('accessDiagnostics') || hasCapability('configurePrinters')) ? el('details', { className: 'diagnostics' }, [
      el('summary', {}, 'Diagnostics'),
      el('div', { className: 'coder-meta' }, [
        keyedDetail('host', 'Host', values.host),
        keyedDetail('mode', 'Mode', values.mode),
        keyedDetail('model', 'Model', values.model),
        keyedDetail('enabled', 'Enabled', values.enabled),
        keyedDetail('connectionState', 'Connection state', values.connectionState),
        keyedDetail('alarm', 'Alarm', values.alarm),
        keyedDetail('rawStatus', 'Raw status', values.rawStatus),
        keyedDetail('lastSuccessDate', 'Last success', values.lastSuccessDate),
        keyedDetail('lastAttemptDate', 'Last attempt', values.lastAttemptDate),
        keyedDetail('failures', 'Failures', values.failures),
        keyedDetail('revision', 'Revision', values.revision)
      ])
    ]) : null,
    el('div', { className: 'card-actions' }, [checkButton, openLink, editButton].filter(Boolean))
  ]);
}

function hasMatchingCards() {
  const cards = [...elements.coderGrid.querySelectorAll('.coder-card[data-id]')];
  return cards.length === state.order.length &&
    state.order.every((id, index) => cards[index]?.dataset.id === id);
}

function renderCoderCards() {
  if (!state.order.length) {
    if (!elements.coderGrid.querySelector('.empty')) {
      clear(elements.coderGrid);
      elements.coderGrid.appendChild(el('article', { className: 'coder-card empty' }, [
        el('h3', { text: 'No coders configured' }),
        el('p', { className: 'muted', text: 'Add up to three coders in data/printers.json.' })
      ]));
    }
    return;
  }

  if (!hasMatchingCards()) {
    clear(elements.coderGrid);
    for (const id of state.order) elements.coderGrid.appendChild(createCoderCard(state.coders[id]));
    return;
  }

  for (const id of state.order) {
    const card = [...elements.coderGrid.querySelectorAll('.coder-card[data-id]')]
      .find((node) => node.dataset.id === id);
    if (card) updateCoderCard(card, state.coders[id]);
  }
}

function renderDashboard() {
  renderCoderCards();

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
      `${enabled.length} enabled | ${online} healthy | ${stale} warning | ${offline} offline | ${unknown} not checked`;
  }

  const operableEnabled = enabled.filter((coder) => canOperatePrinter(coder.config.id));
  elements.checkAllButton.disabled = state.checkingAll || operableEnabled.length === 0 || !state.serverConnected;
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
  if (!canOperatePrinter(id)) return;
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
    if (coder.config.enabled && canOperatePrinter(id)) state.coders[id] = { ...coder, checking: true, lastError: '' };
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

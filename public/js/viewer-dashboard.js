import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { subscribeToPrinterEvents } from './events.js';
import { printerHref, renderNavigation } from './navigation.js';
import { canOperatePrinter, currentSession, loadSession } from './session.js';
import { createOperatorMessageDialog } from './operator-message-dialog.js';
import {
  faultCountLabel,
  formatAge,
  isStale,
  printerState,
  setLiveBadge,
  statusLabel,
  statusTone,
  trafficLightMarkup
} from './status-ui.js';

const elements = {
  grid: document.getElementById('viewerGrid'),
  message: document.getElementById('dashboardMessage'),
  nav: document.getElementById('topNavigation'),
  liveBadge: document.getElementById('serverConnectionBadge')
};

const messageDialog = createOperatorMessageDialog({
  elements: {
    dialog: document.getElementById('setMessageDialog'),
    title: document.getElementById('setMessageDialogTitle'),
    subtitle: document.getElementById('setMessageDialogSubtitle'),
    notice: document.getElementById('setMessageDialogNotice'),
    close: document.getElementById('closeSetMessageDialog'),
    form: document.getElementById('dashboardSetMessageForm'),
    messageName: document.getElementById('dashboardMessageName'),
    fields: document.getElementById('dashboardMessageFields'),
    preview: document.getElementById('dashboardExpectedPreview'),
    reviewSummary: document.getElementById('dashboardReviewSummary'),
    cancel: document.getElementById('cancelSetMessage'),
    review: document.getElementById('reviewSetMessage'),
    confirm: document.getElementById('confirmDashboardSetMessage')
  },
  getStatus: (printerId) => state.statuses[printerId],
  onStatus: (status) => {
    mergeStatus(status);
    render();
  }
});

const state = {
  printers: {},
  order: [],
  statuses: {},
  serverConnected: false,
  lastServerEventAt: Date.now()
};

function mergeStatus(status) {
  const id = status.printerId || status.id;
  if (!id) return;
  state.statuses[id] = { ...state.statuses[id], ...status };
}

function communicationText(status) {
  return statusLabel(status || {});
}

function expectedOutputText(status) {
  return status?.expectedOutput?.rendered || 'No expected output recorded';
}

function cardClass(status) {
  const alarm = status?.decodedStatus?.alarm?.primary;
  const alarmClass = alarm ? ` alarm-${alarm}` : '';
  return `viewer-card status-${statusTone(status || {})}${alarmClass}`;
}

function expectedMessage(status) {
  return status?.expectedOutput?.printerMessageName || null;
}

function readbackUnsupported(printer, status) {
  return status.messageVerification === 'unsupported' || printer.capabilities?.currentMessageReadback === false;
}

function syncState(printer, status) {
  if (!status?.lastSuccessfulAt) return { label: 'WAITING', tone: 'neutral' };
  if (!state.serverConnected) return { label: 'SERVER OFFLINE', tone: 'bad' };
  if (status.online === false) return { label: 'OFFLINE', tone: 'bad' };
  if (isStale(status)) return { label: 'STALE', tone: 'stale' };
  if (status.consecutiveFailures > 0) return { label: 'RETRYING', tone: 'stale' };
  if (readbackUnsupported(printer, status)) return { label: 'READBACK N/A', tone: 'neutral' };
  const expected = expectedMessage(status);
  if (expected && expected !== status.selectedMessage) return { label: 'MISMATCH', tone: 'bad' };
  return { label: 'SYNCED', tone: 'good' };
}

function createReadback(printer, status) {
  const expected = expectedMessage(status);
  const sync = syncState(printer, status);
  let syncMessage = `Server polling is active. ${formatAge(status.lastSuccessfulAt)}.`;
  if (!status.lastSuccessfulAt) syncMessage = 'Waiting for the first successful server poll.';
  else if (!state.serverConnected) syncMessage = 'Live server connection lost. Showing the last successful readback.';
  else if (status.online === false) syncMessage = `Printer is offline. Automatic polling continues. ${status.lastError || ''}`.trim();
  else if (isStale(status)) syncMessage = `Data is stale. Automatic polling continues. ${status.lastError || ''}`.trim();
  else if (status.consecutiveFailures > 0) syncMessage = `Latest poll failed; retrying automatically. ${status.lastError || ''}`.trim();
  else if (readbackUnsupported(printer, status)) {
    syncMessage = `Videojet ${printer.model || '1710'} does not support current-message readback. Status and faults are still polling normally.`;
  }

  return el('section', { className: 'current-message-readback', 'aria-label': 'Current printer message readback' }, [
    el('div', { className: 'readback-heading' }, [
      el('strong', { text: 'Current printer message' }),
      el('span', { className: `badge ${sync.tone}`, text: sync.label })
    ]),
    el('div', { className: 'readback-facts' }, [
      el('span', { text: 'Printer address' }),
      el('strong', { text: `${printer.host}:${printer.port}` }),
      expected ? el('span', { text: 'Expected message' }) : null,
      expected ? el('strong', { text: expected }) : null,
      el('span', { text: 'Current printer message' }),
      el('strong', { text: readbackUnsupported(printer, status) ? 'Verification unavailable' : status.selectedMessage || '-' }),
      el('span', { text: 'Last successful sync' }),
      el('strong', { text: status.lastSuccessfulAt ? new Date(status.lastSuccessfulAt).toLocaleString() : 'Waiting' }),
      el('span', { text: 'Latest attempt' }),
      el('strong', { text: status.lastAttemptAt ? new Date(status.lastAttemptAt).toLocaleString() : 'Waiting' })
    ]),
    el('p', { className: `sync-message sync-${sync.tone}`, text: syncMessage })
  ]);
}

function createCard(printer) {
  const status = state.statuses[printer.id] || {};
  const offline = status.online === false;
  const title = offline ? 'Last known printer status' : 'Printer status';
  const messageLabel = offline ? 'Last known message' : 'Message';
  const faultLabel = offline ? 'Last known active faults' : 'Faults';
  const lightState = printerState(status.decodedStatus);

  return el('article', {
    className: cardClass(status),
    tabindex: '0',
    role: 'link',
    'aria-label': `View ${printer.name}`,
    dataset: { href: printerHref(printer.id) }
  }, [
    el('div', { className: 'viewer-card-top' }, [
      el('h2', { text: printer.name }),
      el('span', { className: 'viewer-comm', text: communicationText(status) })
    ]),
    el('div', { className: 'viewer-status' }, [
      el('span', { text: offline || isStale(status) ? `Last known ${title.toLowerCase()}` : title }),
      trafficLightMarkup(status.decodedStatus, { stale: offline || isStale(status) }),
      el('strong', { text: lightState.label })
    ]),
    el('div', { className: 'viewer-facts' }, [
      el('div', {}, [
        el('span', { text: messageLabel }),
        el('strong', { text: readbackUnsupported(printer, status) ? 'Readback unavailable' : status.selectedMessage || '-' })
      ]),
      el('div', {}, [
        el('span', { text: faultLabel }),
        el('strong', { text: faultCountLabel(status.decodedStatus) })
      ])
    ]),
    el('div', { className: 'viewer-expected' }, [
      el('span', { text: 'Expected print' }),
      el('pre', { text: expectedOutputText(status) })
    ]),
    createReadback(printer, status),
    isStale(status) ? el('p', { className: 'viewer-warning', text: 'Data stale. Showing last known printer state.' }) : null,
    el('div', { className: 'viewer-card-actions' }, [
      canOperatePrinter(printer.id) ? el('button', {
        className: 'primary',
        type: 'button',
        disabled: !printer.enabled ? 'disabled' : null,
        dataset: { action: 'set-message', printerId: printer.id },
        text: 'Set message'
      }) : null,
      el('a', { className: 'card-open-link', href: printerHref(printer.id) }, 'View details')
    ])
  ]);
}

function render() {
  clear(elements.grid);
  if (!state.order.length) {
    const session = currentSession();
    const isDevelopmentOperator = session?.developmentIdentityActive && session.user?.roles?.includes('operator');
    elements.grid.appendChild(el('article', { className: 'viewer-card empty' }, [
      el('h2', {
        text: isDevelopmentOperator
          ? 'Development Operator has no printer assignments. Open Change identity and assign a printer.'
          : 'No printers are assigned to this account.'
      })
    ]));
    return;
  }

  for (const id of state.order) elements.grid.appendChild(createCard(state.printers[id]));
}

function applyFleet(printers) {
  state.printers = {};
  state.order = [];
  for (const printer of printers) {
    state.printers[printer.id] = printer;
    state.order.push(printer.id);
  }
  render();
}

function markConnected() {
  state.serverConnected = true;
  state.lastServerEventAt = Date.now();
  setLiveBadge(elements.liveBadge, true);
}

function markDisconnected() {
  state.serverConnected = false;
  setLiveBadge(elements.liveBadge, false);
  render();
}

async function loadInitialData() {
  try {
    await loadSession();
    renderNavigation(elements.nav, { active: '/dashboard' });
    applyFleet(await apiJson('/api/printers'));
    for (const status of await apiJson('/api/printers/status')) mergeStatus(status);
    setNotice(elements.message);
    render();
  } catch (error) {
    setNotice(elements.message, normalizeError(error), 'error');
  }
}

elements.grid.addEventListener('click', (event) => {
  const setButton = event.target.closest('[data-action="set-message"]');
  if (setButton) {
    event.stopPropagation();
    const printer = state.printers[setButton.dataset.printerId];
    if (printer) messageDialog.open(printer);
    return;
  }
  if (event.target.closest('a, button')) return;
  const card = event.target.closest('[data-href]');
  if (card) window.location.href = card.dataset.href;
});

elements.grid.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-href]');
  if (!card) return;
  event.preventDefault();
  window.location.href = card.dataset.href;
});

subscribeToPrinterEvents({
  onConnected: markConnected,
  onHeartbeat: markConnected,
  onDisconnected: markDisconnected,
  onFleetSnapshot: (printers) => {
    markConnected();
    applyFleet(printers);
  },
  onStatusSnapshot: (statuses) => {
    markConnected();
    for (const status of statuses) mergeStatus(status);
    render();
  },
  onPrinterStatus: (status) => {
    markConnected();
    mergeStatus(status);
    render();
  }
});

setInterval(() => {
  if (Date.now() - state.lastServerEventAt > 45000) markDisconnected();
  render();
}, 5000);

loadInitialData();

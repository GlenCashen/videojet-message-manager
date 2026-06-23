import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { subscribeToPrinterEvents } from './events.js';
import { printerHref, renderNavigation } from './navigation.js';
import { currentSession, loadSession } from './session.js';
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

const state = {
  printers: {},
  order: [],
  statuses: {},
  runningByPrinter: {},
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
    const modelLabel = (printer.protocol || 'wsi') === 'ngpcl' ? 'Markem NGPCL' : `Videojet ${printer.model || '1710'}`;
    syncMessage = `Current-message readback is unavailable on this ${modelLabel}. Status and faults are still polling normally.`;
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
  const running = state.runningByPrinter[printer.id];

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
    running ? el('section', { className: 'viewer-running-release' }, [
      el('span', { text: 'Current running job' }),
      el('strong', { text: `${running.release.brewSheetProduct} · ${running.release.runCode || 'Run pending'}` }),
      el('small', { text: `Started ${running.target.runningAt ? new Date(running.target.runningAt).toLocaleString() : 'recently'}` })
    ]) : el('section', { className: 'viewer-running-release idle' }, [
      el('span', { text: 'Current running job' }), el('strong', { text: 'No release running' })
    ]),
    el('div', { className: 'viewer-expected' }, [
      el('span', { text: 'Expected print' }),
      el('pre', { text: expectedOutputText(status) })
    ]),
    createReadback(printer, status),
    isStale(status) ? el('p', { className: 'viewer-warning', text: 'Data stale. Showing last known printer state.' }) : null,
    el('div', { className: 'viewer-card-actions' }, [
      el('a', { className: 'card-open-link', href: printerHref(printer.id) }, 'Open printer')
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
    const [printers, statuses] = await Promise.all([
      apiJson('/api/printers'),
      apiJson('/api/printers/status')
    ]);
    applyFleet(printers);
    for (const status of statuses) mergeStatus(status);
    await loadRunningReleases();
    setNotice(elements.message);
    render();
  } catch (error) {
    setNotice(elements.message, normalizeError(error), 'error');
  }
}

elements.grid.addEventListener('click', (event) => {
  if (event.target.closest('a, button')) return;
  const card = event.target.closest('[data-href]');
  if (card) window.location.href = card.dataset.href;
});

async function loadRunningReleases() {
  const releases = await apiJson('/api/batch-releases?limit=100');
  state.runningByPrinter = {};
  for (const release of releases) {
    for (const target of release.executionTargets || []) {
      if (target.status === 'running') state.runningByPrinter[target.printerId] = { release, target };
    }
  }
  render();
}

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
  },
  onBatchReleaseExecution: () => loadRunningReleases().catch((error) => setNotice(elements.message, normalizeError(error), 'error'))
});

setInterval(() => {
  if (Date.now() - state.lastServerEventAt > 45000) markDisconnected();
  render();
}, 5000);

loadInitialData();

import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { subscribeToPrinterEvents } from './events.js';
import { printerHref, renderNavigation } from './navigation.js';
import { currentSession, loadSession } from './session.js';
import {
  faultCountLabel,
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
        el('strong', { text: status.selectedMessage || '-' })
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
    isStale(status) ? el('p', { className: 'viewer-warning', text: 'Data stale. Showing last known printer state.' }) : null,
    el('a', { className: 'card-open-link', href: printerHref(printer.id) }, 'View printer')
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
  if (event.target.closest('a')) return;
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
}, 5000);

loadInitialData();

import { applyFleetSnapshot, applyPrinterConfig, applyPrinterEvent, applyStatusSnapshot, loadPrinters, loadStatuses, renderDashboard, setupDashboard } from './js/dashboard.js';
import { setupEditor, startEdit } from './js/editor.js';
import { subscribeToPrinterEvents } from './js/events.js';
import { applyLogEntry, loadLogs, renderLogs, setupLogs } from './js/logs.js';
import { loadMessageConfig, setupMessageConfig } from './js/message-config.js';
import { renderNavigation } from './js/navigation.js';
import { hasCapability, loadSession } from './js/session.js';
import { applyEmulatorState, loadConfig, setupSinglePrinterTools } from './js/single-printer-tools.js';
import { state } from './js/state.js';
import { setLiveBadge } from './js/status-ui.js';
import { normalizeError, setNotice } from './js/dom.js';
import { elements } from './js/elements.js';

function canLoadLogs() {
  return hasCapability('viewAudit') || hasCapability('accessDiagnostics');
}

function applyCapabilityLayout() {
  elements.editorPanel.classList.toggle('hidden', true);
  elements.messageConfigPanel?.classList.toggle('hidden', !hasCapability('editMessages'));
  elements.devPanel?.classList.toggle('hidden', !hasCapability('accessDiagnostics'));
  elements.logPanel?.classList.toggle('hidden', !canLoadLogs());
}

function safeLoadLogs() {
  return canLoadLogs() ? loadLogs() : Promise.resolve();
}

function safeStartEdit(id) {
  if (hasCapability('configurePrinters')) startEdit(id);
}

function setupEventStream() {
  subscribeToPrinterEvents({
    onConnected: markServerConnected,
    onHeartbeat: markServerConnected,
    onDisconnected: markServerDisconnected,

    onPrinterStatus: (payload) => {
      markServerConnected();
      applyPrinterEvent(payload);
    },

    onPrinterConfig: (payload) => {
      markServerConnected();
      applyPrinterConfig(payload);
    },

    onFaultActivated: () => {
      markServerConnected();
    },

    onFaultCleared: () => {
      markServerConnected();
    },

    onStatusSnapshot: (payload) => {
      markServerConnected();
      applyStatusSnapshot(payload);
    },

    onFleetSnapshot: (payload) => {
      markServerConnected();
      applyFleetSnapshot(payload);
    },

    onLogsSnapshot: (payload) => {
      markServerConnected();
      if (canLoadLogs()) renderLogs(payload);
    },

    onLogEntry: (payload) => {
      markServerConnected();
      if (canLoadLogs()) applyLogEntry(payload);
    },

    onEmulatorSnapshot: (payload) => {
      markServerConnected();
      if (hasCapability('accessDiagnostics')) applyEmulatorState(payload);
    }
  });
}

function markServerConnected() {
  const wasConnected = state.serverConnected;
  state.lastServerEventAt = Date.now();
  state.serverConnected = true;

  document.body.classList.remove('server-disconnected');
  document.body.classList.add('server-connected');

  setLiveBadge(document.getElementById('serverConnectionBadge'), true);
  if (!wasConnected) renderDashboard();
}

function markServerDisconnected() {
  if (!state.serverConnected) return;
  state.serverConnected = false;

  document.body.classList.remove('server-connected');
  document.body.classList.add('server-disconnected');

  setLiveBadge(document.getElementById('serverConnectionBadge'), false);
  renderDashboard();
}
setInterval(() => {
  const age = Date.now() - state.lastServerEventAt;

  if (age > 45000) {
    markServerDisconnected();
  }
}, 5000);

async function start() {
  try {
    await loadSession();
    renderNavigation(elements.topNavigation, { active: '/editor' });

    if (!hasCapability('viewEditor')) {
      setNotice(elements.dashboardMessage, 'You do not have permission to view the editor.', 'error');
      return;
    }

    applyCapabilityLayout();
    setupDashboard({ loadLogs: safeLoadLogs, startEdit: safeStartEdit });
    if (hasCapability('configurePrinters')) setupEditor({ loadPrinters });
    if (canLoadLogs()) setupLogs();
    if (hasCapability('editMessages')) setupMessageConfig();
    if (hasCapability('accessDiagnostics')) setupSinglePrinterTools({ loadLogs: safeLoadLogs });
    setupEventStream();

    await Promise.all([
      hasCapability('accessDiagnostics') ? loadConfig() : Promise.resolve(),
      loadPrinters().then(loadStatuses),
      safeLoadLogs(),
      hasCapability('editMessages') ? loadMessageConfig() : Promise.resolve()
    ]);
  } catch (error) {
    setNotice(elements.dashboardMessage, normalizeError(error), 'error');
  }
}

start();

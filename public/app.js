import { applyFleetSnapshot, applyPrinterConfig, applyPrinterEvent, applyStatusSnapshot, loadPrinters, loadStatuses, renderDashboard, setupDashboard } from './js/dashboard.js';
import { setupEditor, startEdit } from './js/editor.js';
import { subscribeToPrinterEvents } from './js/events.js';
import { applyLogEntry, loadLogs, renderLogs, setupLogs } from './js/logs.js';
import { loadMessageConfig, setupMessageConfig } from './js/message-config.js';
import { applyEmulatorState, loadConfig, setupSinglePrinterTools } from './js/single-printer-tools.js';
import { state } from './js/state.js';
import { setLiveBadge } from './js/status-ui.js';

setupDashboard({ loadLogs, startEdit });
setupEditor({ loadPrinters });
setupLogs();
setupMessageConfig();
setupSinglePrinterTools({ loadLogs });
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
    renderLogs(payload);
  },

  onLogEntry: (payload) => {
    markServerConnected();
    applyLogEntry(payload);
  },

  onEmulatorSnapshot: (payload) => {
    markServerConnected();
    applyEmulatorState(payload);
  }
});
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
Promise.all([loadConfig(), loadPrinters().then(loadStatuses), loadLogs(), loadMessageConfig()]);

import { applyFleetSnapshot, applyPrinterConfig, applyPrinterEvent, applyStatusSnapshot, loadPrinters, loadStatuses, setupDashboard } from './js/dashboard.js';
import { setupEditor, startEdit } from './js/editor.js';
import { subscribeToPrinterEvents } from './js/events.js';
import { applyLogEntry, loadLogs, renderLogs, setupLogs } from './js/logs.js';
import { applyEmulatorState, loadConfig, setupSinglePrinterTools } from './js/single-printer-tools.js';

let lastServerEventAt = Date.now();
let serverConnected = false;

setupDashboard({ loadLogs, startEdit });
setupEditor({ loadPrinters });
setupLogs();
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
  lastServerEventAt = Date.now();
  serverConnected = true;

  document.body.classList.remove('server-disconnected');
  document.body.classList.add('server-connected');

  const badge = document.getElementById('serverConnectionBadge');
  if (badge) {
    badge.className = 'live-indicator connected';
    badge.querySelector('span:last-child').textContent = 'Live data connected';
  }
}

function markServerDisconnected() {
  serverConnected = false;

  document.body.classList.remove('server-connected');
  document.body.classList.add('server-disconnected');

  const badge = document.getElementById('serverConnectionBadge');
  if (badge) {
    badge.className = 'live-indicator disconnected';
    badge.querySelector('span:last-child').textContent = 'Live data lost';
  }
}
setInterval(() => {
  const age = Date.now() - lastServerEventAt;

  if (age > 45000) {
    markServerDisconnected();
  }
}, 5000);
Promise.all([loadConfig(), loadPrinters().then(loadStatuses), loadLogs()]);

import { applyFleetSnapshot, applyPrinterConfig, applyPrinterEvent, applyStatusSnapshot, loadPrinters, loadStatuses, setupDashboard } from './js/dashboard.js';
import { setupEditor, startEdit } from './js/editor.js';
import { subscribeToPrinterEvents } from './js/events.js';
import { applyLogEntry, loadLogs, renderLogs, setupLogs } from './js/logs.js';
import { applyEmulatorState, loadConfig, setupSinglePrinterTools } from './js/single-printer-tools.js';

setupDashboard({ loadLogs, startEdit });
setupEditor({ loadPrinters });
setupLogs();
setupSinglePrinterTools({ loadLogs });
subscribeToPrinterEvents({
  onPrinterStatus: applyPrinterEvent,
  onPrinterConfig: applyPrinterConfig,
  onStatusSnapshot: applyStatusSnapshot,
  onFleetSnapshot: applyFleetSnapshot,
  onLogsSnapshot: renderLogs,
  onLogEntry: applyLogEntry,
  onEmulatorSnapshot: applyEmulatorState
});

Promise.all([loadConfig(), loadPrinters().then(loadStatuses), loadLogs()]);

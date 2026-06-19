import { apiJson } from './api.js';
import { clear, el, formatDate, normalizeError } from './dom.js';
import { elements } from './elements.js';

let cachedLogs = [];

function addCell(row, value, className = '') {
  row.appendChild(el('td', { className, text: value || '' }));
}

function renderLogs(logs) {
  cachedLogs = Array.isArray(logs) ? logs : [];
  clear(elements.logBody);
  if (!cachedLogs.length) {
    const row = el('tr');
    row.appendChild(el('td', { colspan: '7', className: 'muted', text: 'No commands yet.' }));
    elements.logBody.appendChild(row);
    return;
  }

  for (const log of cachedLogs) {
    const details = log.details || {};
    const succeeded = details.ok ?? log.ok;
    const target = log.targetType
      ? `${log.targetType}${log.targetId ? ` · ${log.targetId.slice(0, 8)}` : ''}`
      : (log.printerId || details.printerId || '');
    const detail = details.reason
      || details.runCode
      || details.brewSheetProduct
      || log.selectedMessage
      || log.message
      || log.expectedMessage
      || log.fieldValue
      || '';
    const row = el('tr');
    addCell(row, formatDate(log.occurredAt || log.time));
    addCell(row, log.action || '');
    addCell(row, log.actorUsername || log.actor || 'System');
    addCell(row, target);
    addCell(row, detail);
    addCell(row, details.status || log.status || '');
    addCell(row, succeeded === false ? details.error || log.error || 'Failed' : 'OK', succeeded === false ? 'result-bad' : 'result-ok');
    elements.logBody.appendChild(row);
  }
}

function applyLogEntry(log) {
  renderLogs([log, ...cachedLogs].slice(0, 200));
}

async function loadLogs() {
  try {
    renderLogs(await apiJson('/api/logs'));
  } catch (error) {
    clear(elements.logBody);
    const row = el('tr');
    row.appendChild(el('td', { colspan: '7', className: 'error-cell', text: normalizeError(error) }));
    elements.logBody.appendChild(row);
  }
}

function setupLogs() {
  elements.refreshLogs.addEventListener('click', (event) => {
    event.stopPropagation();
    loadLogs();
  });
}

export { applyLogEntry, loadLogs, renderLogs, setupLogs };

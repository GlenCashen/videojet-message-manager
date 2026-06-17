import { apiJson, postJson } from './js/api.js';
import { normalizeError, setNotice } from './js/dom.js';
import { subscribeToPrinterEvents } from './js/events.js';
import {
  faultSummary,
  formatAge,
  isStale,
  isVisibleBusy,
  setLiveBadge,
  statusLabel,
  statusTone
} from './js/status-ui.js';

const $ = (id) => document.getElementById(id);
const elements = {
  title: $('printerTitle'),
  subtitle: $('printerSubtitle'),
  checkButton: $('operatorCheckButton'),
  message: $('operatorMessage'),
  statusPanel: $('operatorStatus'),
  statusLight: $('operatorStatusLight'),
  connection: $('operatorConnection'),
  selectedMessage: $('operatorSelectedMessage'),
  faults: $('operatorFaults'),
  dataSource: $('operatorDataSource'),
  liveNote: $('operatorLiveNote'),
  printerStatus: $('operatorPrinterStatus'),
  checkedAt: $('operatorCheckedAt'),
  host: $('operatorHost'),
  mode: $('operatorMode'),
  form: $('operatorSetForm'),
  setButton: $('operatorSetButton'),
  messageName: $('operatorMessageName'),
  fieldName: $('operatorFieldName'),
  fieldValue: $('operatorFieldValue'),
  messageFields: $('messageFields'),
  expectedPreview: $('expectedPreview')
};

const params = new URLSearchParams(window.location.search);
const printerId = params.get('id');

let printer = null;
let latestStatus = null;
let lastServerEventAt = Date.now();
let serverConnected = false;

function setBusy(busy) {
  const disabled = busy || !printer?.enabled || !serverConnected;

  elements.checkButton.disabled = disabled;
  elements.setButton.disabled = disabled;
}

function updateMessageFields() {
  if (!elements.messageFields) return;

  elements.messageFields.textContent = `${elements.fieldName.value.trim() || 'Text user field'} = ${elements.fieldValue.value || '-'}`;

  if (elements.expectedPreview) {
    elements.expectedPreview.textContent = 'Preview unavailable until this message is configured.';
  }
}

function updateOperatorShell() {
  const sourceText = serverConnected ? 'Live data stream' : 'Last known status';
  const visibleBusy = isVisibleBusy(latestStatus);
  const tone = printer?.enabled ? statusTone(latestStatus || { state: 'not-checked' }) : 'disabled';

  elements.statusPanel.className = `operator-status status-${tone}`;
  elements.dataSource.textContent = sourceText;
  elements.liveNote.textContent = serverConnected
    ? 'Live status is streaming from the server.'
    : 'Live data lost. Last known printer state remains on screen.';

  if (latestStatus) {
    elements.connection.textContent = visibleBusy ? statusLabel(latestStatus) : statusLabel(latestStatus);
    elements.selectedMessage.textContent = latestStatus.selectedMessage || '-';
    elements.faults.textContent = faultSummary(latestStatus.decodedStatus);
    elements.printerStatus.textContent = latestStatus.rawStatus || latestStatus.status || '-';
    elements.checkedAt.textContent = formatAge(latestStatus.lastSuccessfulAt);

    if (isStale(latestStatus) && serverConnected) {
      setNotice(elements.message, 'Printer status is stale. Waiting for a fresh server update.', 'error');
    }
  } else if (printer && !printer.enabled) {
    elements.connection.textContent = 'Disabled';
    elements.faults.textContent = 'Coder is disabled';
    elements.checkedAt.textContent = 'No update yet';
  }

  setBusy(visibleBusy);
}

function applyPrinterConfig(value) {
  printer = value;
  elements.title.textContent = printer.name;
  elements.subtitle.textContent = printer.location || 'No location set';
  elements.host.textContent = `${printer.host}:${printer.port}`;
  elements.mode.textContent = printer.mode === 'emulator' ? 'Emulator' : 'Real printer';

  if (!printer.enabled) {
    setNotice(elements.message, `${printer.name} is disabled.`, 'error');
  }

  updateOperatorShell();
}

function applyPrinterStatus(value) {
  const id = value.id || value.printerId;
  if (id !== printerId) return;

  if (value.currentOperation === 'poll' && value.busy) return;

  const visibleBusy = isVisibleBusy(value);
  latestStatus = {
    ...latestStatus,
    ...value,
    selectedMessage: value.selectedMessage || latestStatus?.selectedMessage || '-',
    rawStatus: value.rawStatus || value.status || latestStatus?.rawStatus || latestStatus?.status || null,
    decodedStatus: value.decodedStatus || latestStatus?.decodedStatus || null,
    lastSuccessfulAt: value.lastSuccessfulAt || latestStatus?.lastSuccessfulAt || null,
    busy: visibleBusy,
    currentOperation: visibleBusy ? value.currentOperation || null : null
  };

  if (value.ok === false) {
    setNotice(elements.message, value.error || 'Printer request failed.', 'error');
  } else if (visibleBusy) {
    setNotice(elements.message, 'Printer operation in progress...');
  } else if (serverConnected && !isStale(latestStatus)) {
    setNotice(elements.message);
  }

  updateOperatorShell();
}

async function loadPrinter() {
  if (!printerId) {
    setNotice(elements.message, 'No coder id was provided in the page URL.', 'error');
    setBusy(true);
    return;
  }

  try {
    applyPrinterConfig(await apiJson(`/api/printers/${encodeURIComponent(printerId)}`));
    const cached = await apiJson(`/api/printers/${encodeURIComponent(printerId)}/status`);
    applyPrinterStatus(cached);
  } catch (error) {
    setNotice(elements.message, normalizeError(error), 'error');
    setBusy(true);
  }
}

async function checkPrinter() {
  if (!printer || !printer.enabled || !serverConnected) return;

  setBusy(true);
  setNotice(elements.message, 'Checking coder...');
  try {
    const result = await postJson(`/api/printers/${encodeURIComponent(printerId)}/check`, {});
    applyPrinterStatus(result);
  } catch (error) {
    applyPrinterStatus({
      ok: false,
      printerId,
      online: false,
      error: normalizeError(error),
      checkedAt: new Date().toISOString()
    });
  } finally {
    setBusy(false);
  }
}

async function setPrinter(event) {
  event.preventDefault();
  if (!printer || !printer.enabled || !serverConnected) return;

  setBusy(true);
  setNotice(elements.message, 'Queued message request...');
  try {
    const result = await postJson(`/api/printers/${encodeURIComponent(printerId)}/set`, {
      messageName: elements.messageName.value,
      fieldName: elements.fieldName.value.trim(),
      fieldValue: elements.fieldValue.value,
      expectedRevision: latestStatus?.revision
    });
    applyPrinterStatus(result);
    setNotice(
      elements.message,
      result.messageMatches ? 'Message set and read back.' : 'Message sent, but readback did not match.',
      result.messageMatches ? 'success' : 'error'
    );
  } catch (error) {
    applyPrinterStatus({
      ok: false,
      printerId,
      online: false,
      error: normalizeError(error),
      checkedAt: new Date().toISOString()
    });
  } finally {
    setBusy(false);
  }
}

function markServerConnected() {
  lastServerEventAt = Date.now();
  serverConnected = true;

  document.body.classList.remove('server-disconnected');
  document.body.classList.add('server-connected');

  setLiveBadge(document.getElementById('serverConnectionBadge'), true);
  updateOperatorShell();
}

function markServerDisconnected() {
  serverConnected = false;

  document.body.classList.remove('server-connected');
  document.body.classList.add('server-disconnected');

  setLiveBadge(document.getElementById('serverConnectionBadge'), false);
  setNotice(elements.message, 'Server disconnected. Showing the last known printer status.', 'error');
  updateOperatorShell();
}

elements.checkButton.addEventListener('click', checkPrinter);
elements.form.addEventListener('submit', setPrinter);
elements.messageName.addEventListener('change', updateMessageFields);
elements.fieldName.addEventListener('input', updateMessageFields);
elements.fieldValue.addEventListener('input', updateMessageFields);

subscribeToPrinterEvents({
  onConnected: markServerConnected,
  onHeartbeat: markServerConnected,
  onDisconnected: markServerDisconnected,

  onPrinterStatus: (value) => {
    markServerConnected();
    applyPrinterStatus(value);
  },

  onPrinterConfig: (value) => {
    markServerConnected();

    if (value.id === printerId) {
      applyPrinterConfig(value);
    }
  },

  onStatusSnapshot: (statuses) => {
    markServerConnected();

    const match = statuses.find((value) => value.printerId === printerId || value.id === printerId);
    if (match) applyPrinterStatus(match);
  },

  onFleetSnapshot: (printers) => {
    markServerConnected();

    const match = printers.find((value) => value.id === printerId);
    if (match) applyPrinterConfig(match);
  }
});

updateMessageFields();
loadPrinter();
setInterval(() => {
  const age = Date.now() - lastServerEventAt;
  if (age > 45000) markServerDisconnected();
}, 5000);
setInterval(updateOperatorShell, 10000);

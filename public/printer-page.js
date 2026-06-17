import { apiJson, postJson } from './js/api.js';
import { formatDate, normalizeError, setNotice } from './js/dom.js';
import { subscribeToPrinterEvents } from './js/events.js';

const $ = (id) => document.getElementById(id);
const elements = {
  title: $('printerTitle'),
  subtitle: $('printerSubtitle'),
  checkButton: $('operatorCheckButton'),
  message: $('operatorMessage'),
  connection: $('operatorConnection'),
  selectedMessage: $('operatorSelectedMessage'),
  printerStatus: $('operatorPrinterStatus'),
  checkedAt: $('operatorCheckedAt'),
  host: $('operatorHost'),
  mode: $('operatorMode'),
  form: $('operatorSetForm'),
  setButton: $('operatorSetButton'),
  messageName: $('operatorMessageName'),
  fieldName: $('operatorFieldName'),
  fieldValue: $('operatorFieldValue')
};

const params = new URLSearchParams(window.location.search);
const printerId = params.get('id');
const STALE_AFTER_MS = 45000;
let printer = null;
let latestStatus = null;
let lastServerEventAt = Date.now();
let serverConnected = false;

function setBusy(busy) {
  const disabled = busy || !printer?.enabled || !serverConnected;

  elements.checkButton.disabled = disabled;
  elements.setButton.disabled = disabled;
}

function applyPrinterConfig(value) {
  printer = value;
  elements.title.textContent = printer.name;
  elements.subtitle.textContent = printer.location || 'No location set';
  elements.host.textContent = `${printer.host}:${printer.port}`;
  elements.mode.textContent = printer.mode === 'emulator' ? 'Emulator' : 'Real printer';
  setBusy(false);
  if (!printer.enabled) {
    elements.connection.textContent = 'Disabled';
    setNotice(elements.message, `${printer.name} is disabled.`, 'error');
  }
}

function applyPrinterStatus(value) {
  const id = value.id || value.printerId;
  if (id !== printerId) return;

  latestStatus = value;

  const isBackgroundPoll = value.currentOperation === 'poll';
  const visibleBusy = Boolean(value.busy && !isBackgroundPoll);

  if (value.ok === false || value.online === false) {
    elements.connection.textContent = 'Offline / error';
  } else {
    elements.connection.textContent = 'Online';
  }

  if (visibleBusy) {
    elements.connection.textContent = value.currentOperation
      ? `Busy: ${value.currentOperation}`
      : 'Busy';
  }

  if (value.stale && value.online) {
    elements.connection.textContent += ' / stale';
  }

  elements.selectedMessage.textContent = value.selectedMessage || '-';
  elements.printerStatus.textContent = value.rawStatus || value.status || '-';
  elements.checkedAt.textContent = formatDate(
    value.lastSuccessfulAt || value.checkedAt || value.lastAttemptAt
  );

  setBusy(visibleBusy);

  if (value.ok === false) {
    setNotice(
      elements.message,
      value.error || 'Printer request failed.',
      'error'
    );
  } else if (visibleBusy) {
    setNotice(elements.message, 'Printer operation in progress...');
  } else if (serverConnected) {
    setNotice(elements.message);
  }

  updateStaleIndicator();
}


function updateStaleIndicator() {
  if (!serverConnected) return;
  if (!printer?.enabled) return;

  const timestamp =
    latestStatus?.lastSuccessfulAt ||
    latestStatus?.checkedAt ||
    latestStatus?.lastAttemptAt;

  if (!timestamp) return;

  const checkedAt = new Date(timestamp).valueOf();
  if (!Number.isFinite(checkedAt)) return;

  const stale =
    Boolean(latestStatus?.stale) ||
    Date.now() - checkedAt > STALE_AFTER_MS;

  if (!stale) return;

  const baseText = elements.connection.textContent
    .replace(' / stale', '');

  elements.connection.textContent = `${baseText} / stale`;

  setNotice(
    elements.message,
    'Printer status is stale. Waiting for a fresh server update.',
    'error'
  );
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
      result.messageMatches ? 'Message set and verified.' : 'Message sent, but readback did not match.',
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

  const badge = document.getElementById('serverConnectionBadge');

  if (badge) {
    badge.className = 'live-indicator connected';

    const label = badge.querySelector('span:last-child');
    if (label) label.textContent = 'Live data connected';
  }

  const visibleBusy =
    Boolean(latestStatus?.busy) &&
    latestStatus?.currentOperation !== 'poll';

  setBusy(visibleBusy);
}

function markServerDisconnected() {
  serverConnected = false;

  document.body.classList.remove('server-connected');
  document.body.classList.add('server-disconnected');

  const badge = document.getElementById('serverConnectionBadge');

  if (badge) {
    badge.className = 'live-indicator disconnected';

    const label = badge.querySelector('span:last-child');
    if (label) label.textContent = 'Live data lost';
  }

  setBusy(true);
  setNotice(
    elements.message,
    'Server disconnected. Showing the last known printer status.',
    'error'
  );
}

elements.checkButton.addEventListener('click', checkPrinter);
elements.form.addEventListener('submit', setPrinter);

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

    const match = statuses.find(
      (value) => value.printerId === printerId
    );

    if (match) {
      applyPrinterStatus(match);
    }
  },

  onFleetSnapshot: (printers) => {
    markServerConnected();

    const match = printers.find(
      (value) => value.id === printerId
    );

    if (match) {
      applyPrinterConfig(match);
    }
  }
});



loadPrinter();
setInterval(() => {
  const age = Date.now() - lastServerEventAt;

  if (age > 45000) {
    markServerDisconnected();
  }
}, 5000);
setInterval(updateStaleIndicator, 10000);

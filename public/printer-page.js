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

function setBusy(busy) {
  elements.checkButton.disabled = busy || !printer?.enabled;
  elements.setButton.disabled = busy || !printer?.enabled;
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
  elements.connection.textContent = value.ok === false || value.online === false ? 'Offline / error' : 'Online';
  if (value.busy) elements.connection.textContent = value.currentOperation ? `Busy: ${value.currentOperation}` : 'Busy';
  if (value.stale && value.online) elements.connection.textContent = `${elements.connection.textContent} / stale`;
  elements.selectedMessage.textContent = value.selectedMessage || '-';
  elements.printerStatus.textContent = value.rawStatus || value.status || '-';
  elements.checkedAt.textContent = formatDate(value.lastSuccessfulAt || value.checkedAt);
  if (value.ok === false) setNotice(elements.message, value.error || 'Printer request failed.', 'error');
  else setNotice(elements.message, 'Status updated.', 'success');
  updateStaleIndicator();
}

function updateStaleIndicator() {
  if (!latestStatus?.checkedAt || !printer?.enabled) return;
  const checkedAt = new Date(latestStatus.checkedAt).valueOf();
  if (!Number.isFinite(checkedAt)) return;
  const stale = Date.now() - checkedAt > STALE_AFTER_MS;
  if (!stale) return;
  elements.connection.textContent = `${elements.connection.textContent.replace(' / stale', '')} / stale`;
  setNotice(elements.message, 'Status data is getting old. Waiting for the live stream or next poll.', 'error');
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
    await checkPrinter();
  } catch (error) {
    setNotice(elements.message, normalizeError(error), 'error');
    setBusy(true);
  }
}

async function checkPrinter() {
  if (!printer || !printer.enabled) return;
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
  if (!printer || !printer.enabled) return;
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

elements.checkButton.addEventListener('click', checkPrinter);
elements.form.addEventListener('submit', setPrinter);
subscribeToPrinterEvents({
  onPrinterStatus: applyPrinterStatus,
  onPrinterConfig: (value) => {
    if (value.id === printerId) applyPrinterConfig(value);
  },
  onStatusSnapshot: (statuses) => {
    const match = statuses.find((value) => value.printerId === printerId);
    if (match) applyPrinterStatus(match);
  },
  onFleetSnapshot: (printers) => {
    const match = printers.find((value) => value.id === printerId);
    if (match) applyPrinterConfig(match);
  }
});

loadPrinter();
setInterval(updateStaleIndicator, 10000);

import { apiJson, postJson } from './js/api.js';
import { clear, el, normalizeError, setNotice } from './js/dom.js';
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
  messageFields: $('messageFields'),
  expectedPreview: $('expectedPreview'),
  reviewPanel: $('reviewPanel'),
  reviewContent: $('reviewContent'),
  cancelReviewButton: $('cancelReviewButton'),
  confirmSetButton: $('confirmSetButton')
};

const params = new URLSearchParams(window.location.search);
const printerId = params.get('id');
const PREVIEW_DEBOUNCE_MS = 250;

let printer = null;
let latestStatus = null;
let messages = [];
let latestPreview = null;
let lastServerEventAt = Date.now();
let serverConnected = false;
let manualBusy = false;
let previewTimer = null;
let previewRequestId = 0;

function selectedMessageDefinition() {
  return messages.find((message) => message.id === elements.messageName.value) || null;
}

function dynamicFieldInputs() {
  return [...elements.messageFields.querySelectorAll('input[data-field-key]')];
}

function setBusy(busy) {
  manualBusy = busy;
  const disabled = busy || !printer?.enabled || !serverConnected;

  elements.checkButton.disabled = disabled;
  elements.setButton.disabled = disabled || !messages.length;
  elements.messageName.disabled = disabled || !messages.length;
  elements.confirmSetButton.disabled = disabled;
  for (const input of dynamicFieldInputs()) input.disabled = disabled;
}

function currentFieldValues() {
  const fields = {};
  for (const input of dynamicFieldInputs()) fields[input.dataset.fieldKey] = input.value.trim();
  return fields;
}

function validateFieldValues() {
  const definition = selectedMessageDefinition();
  const fields = currentFieldValues();
  const errors = {};

  if (!definition) return { valid: false, fields, errors: { message: 'Select a message.' } };

  for (const field of definition.fields) {
    const value = fields[field.key] || '';
    if (field.required && !value) errors[field.key] = `${field.label} is required.`;
    else if (value.length > field.maxLength) errors[field.key] = `${field.label} must be ${field.maxLength} characters or fewer.`;
  }

  return { valid: Object.keys(errors).length === 0, fields, errors };
}

function setFieldErrors(errors = {}) {
  for (const node of elements.messageFields.querySelectorAll('[data-field-error]')) {
    node.textContent = errors[node.dataset.fieldError] || '';
  }
}

function hideReview() {
  elements.reviewPanel.classList.add('hidden');
  clear(elements.reviewContent);
}

function renderMessageFields() {
  const definition = selectedMessageDefinition();
  clear(elements.messageFields);
  latestPreview = null;
  hideReview();

  if (!definition) {
    elements.messageFields.textContent = 'No message definitions available.';
    elements.expectedPreview.textContent = 'Preview unavailable until this message is configured.';
    return;
  }

  for (const field of definition.fields) {
    const input = el('input', {
      id: `field-${field.key}`,
      name: field.key,
      maxlength: String(field.maxLength),
      required: field.required ? 'required' : null,
      autocomplete: 'off',
      dataset: { fieldKey: field.key }
    });
    input.addEventListener('input', () => {
      hideReview();
      schedulePreview();
    });

    elements.messageFields.appendChild(el('label', { for: input.id }, [
      el('span', { text: field.required ? `${field.label} *` : field.label }),
      input,
      el('small', { className: 'field-error', dataset: { fieldError: field.key } })
    ]));
  }

  setBusy(manualBusy);
  schedulePreview();
}

function renderMessageOptions() {
  clear(elements.messageName);
  for (const message of messages) {
    elements.messageName.appendChild(el('option', {
      value: message.id,
      text: message.displayName
    }));
  }
  renderMessageFields();
}

function showPreviewPlaceholder(text) {
  latestPreview = null;
  elements.expectedPreview.textContent = text;
}

async function refreshPreviewNow() {
  const definition = selectedMessageDefinition();
  const validation = validateFieldValues();
  setFieldErrors(validation.errors);

  if (!definition) {
    showPreviewPlaceholder('No message definitions available.');
    return null;
  }
  if (!validation.valid) {
    showPreviewPlaceholder('Enter all required fields to preview this message.');
    return null;
  }

  const requestId = ++previewRequestId;
  elements.expectedPreview.textContent = 'Generating preview...';

  try {
    const preview = await postJson(`/api/messages/${encodeURIComponent(definition.id)}/preview`, {
      fields: validation.fields
    });
    if (requestId !== previewRequestId) return latestPreview;

    latestPreview = preview;
    elements.expectedPreview.textContent = preview.rendered;
    return preview;
  } catch (error) {
    if (requestId === previewRequestId) showPreviewPlaceholder(normalizeError(error));
    return null;
  }
}

function schedulePreview() {
  window.clearTimeout(previewTimer);
  const validation = validateFieldValues();
  setFieldErrors(validation.errors);
  if (!validation.valid) {
    showPreviewPlaceholder('Enter all required fields to preview this message.');
    return;
  }
  elements.expectedPreview.textContent = 'Preview will update shortly...';
  previewTimer = window.setTimeout(refreshPreviewNow, PREVIEW_DEBOUNCE_MS);
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
    elements.connection.textContent = statusLabel(latestStatus);
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

  setBusy(visibleBusy || manualBusy);
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

  if (value.ok === false && !value.messageMatches) {
    setNotice(elements.message, value.error || 'Printer request failed.', 'error');
  } else if (visibleBusy) {
    setNotice(elements.message, 'Printer operation in progress...');
  } else if (serverConnected && !isStale(latestStatus)) {
    setNotice(elements.message);
  }

  updateOperatorShell();
}

async function loadMessages() {
  if (!printerId) return;
  messages = await apiJson(`/api/printers/${encodeURIComponent(printerId)}/messages`);
  renderMessageOptions();
}

async function loadPrinter() {
  if (!printerId) {
    setNotice(elements.message, 'No coder id was provided in the page URL.', 'error');
    setBusy(true);
    return;
  }

  try {
    applyPrinterConfig(await apiJson(`/api/printers/${encodeURIComponent(printerId)}`));
    await loadMessages();
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

function appendReviewLine(label, value) {
  elements.reviewContent.appendChild(el('div', { className: 'review-line' }, [
    el('span', { text: label }),
    el('strong', { text: value })
  ]));
}

function renderReview(preview) {
  const definition = selectedMessageDefinition();
  const fields = currentFieldValues();
  clear(elements.reviewContent);
  elements.reviewPanel.classList.remove('hidden');
  elements.reviewPanel.querySelector('h3').textContent = `Apply to ${printer.name}?`;

  appendReviewLine('Message', definition.displayName);
  for (const field of definition.fields) appendReviewLine(field.label.replace(/ code$/i, ''), fields[field.key]);
  elements.reviewContent.appendChild(el('div', { className: 'review-preview' }, [
    el('span', { text: 'Expected printed message:' }),
    el('pre', { text: preview.rendered })
  ]));
}

async function reviewPrinterUpdate(event) {
  event.preventDefault();
  if (!printer || !printer.enabled || !serverConnected || manualBusy) return;

  const preview = await refreshPreviewNow();
  if (!preview) {
    setNotice(elements.message, 'Enter all required fields before reviewing this update.', 'error');
    return;
  }

  setNotice(elements.message);
  renderReview(preview);
}

function fieldResultLine(result) {
  return `${result.printerFieldName} update: ${result.acknowledged ? 'Acknowledged' : 'Failed'}`;
}

function showUpdateResult(result) {
  applyPrinterStatus(result);

  if (result.messageMatches) {
    const fieldLines = (result.fieldResults || []).map(fieldResultLine).join('\n');
    setNotice(
      elements.message,
      `Printer updated successfully\n\nSelected message: Verified\n${fieldLines}\nPhysical print check: Required`,
      'success'
    );
    return;
  }

  if (result.selectedMessage) {
    setNotice(
      elements.message,
      `MESSAGE MISMATCH\n\nRequested: ${result.requestedMessage}\nPrinter reports: ${result.selectedMessage}\n\nDo not start production.`,
      'error'
    );
    return;
  }

  const fieldLines = (result.fieldResults || []).map((field) =>
    `${field.printerFieldName}: ${field.acknowledged ? 'Acknowledged' : 'Failed'}`
  ).join('\n');
  setNotice(
    elements.message,
    `Message update failed\n\n${fieldLines}\nMessage selection: ${result.messageSelection || 'Not attempted'}`,
    'error'
  );
}

async function confirmPrinterUpdate() {
  if (!printer || !printer.enabled || !serverConnected || manualBusy) return;

  const definition = selectedMessageDefinition();
  const validation = validateFieldValues();
  setFieldErrors(validation.errors);
  if (!definition || !validation.valid) {
    setNotice(elements.message, 'Enter all required fields before setting the printer.', 'error');
    return;
  }

  setBusy(true);
  setNotice(elements.message, 'Queued message request...');
  try {
    const result = await postJson(`/api/printers/${encodeURIComponent(printerId)}/set`, {
      messageId: definition.id,
      fields: validation.fields,
      expectedRevision: latestStatus?.revision
    });
    hideReview();
    showUpdateResult(result);
  } catch (error) {
    hideReview();
    if (error.data?.fieldResults || error.data?.selectedMessage) showUpdateResult(error.data);
    else {
      applyPrinterStatus({
        ok: false,
        printerId,
        online: false,
        error: normalizeError(error),
        checkedAt: new Date().toISOString()
      });
    }
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
  if (!serverConnected) return;
  serverConnected = false;

  document.body.classList.remove('server-connected');
  document.body.classList.add('server-disconnected');

  setLiveBadge(document.getElementById('serverConnectionBadge'), false);
  setNotice(elements.message, 'Server disconnected. Showing the last known printer status.', 'error');
  updateOperatorShell();
}

elements.checkButton.addEventListener('click', checkPrinter);
elements.form.addEventListener('submit', reviewPrinterUpdate);
elements.messageName.addEventListener('change', () => {
  hideReview();
  renderMessageFields();
});
elements.cancelReviewButton.addEventListener('click', hideReview);
elements.confirmSetButton.addEventListener('click', confirmPrinterUpdate);

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
    if (match) {
      applyPrinterConfig(match);
      loadMessages().catch((error) => setNotice(elements.message, normalizeError(error), 'error'));
    }
  }
});

loadPrinter();
setInterval(() => {
  const age = Date.now() - lastServerEventAt;
  if (age > 45000) markServerDisconnected();
}, 5000);
setInterval(updateOperatorShell, 10000);

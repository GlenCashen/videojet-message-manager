import { apiJson, postJson } from './js/api.js';
import { clear, el, normalizeError, setNotice } from './js/dom.js';
import { subscribeToPrinterEvents } from './js/events.js';
import { printerHref, renderNavigation } from './js/navigation.js';
import { createOperatorReleaseQueue } from './js/operator-release-queue.js';
import { expectedOutputText, messageExpectedOutput } from './js/release-preview.js';
import { canOperatePrinter, currentSession, loadSession } from './js/session.js';
import {
  activeFaults,
  faultSummary,
  formatDuration,
  isStale,
  isVisibleBusy,
  messageMismatch,
  printerState,
  setLiveBadge,
  statusLabel,
  statusTone,
  trafficLightMarkup
} from './js/status-ui.js';

const $ = (id) => document.getElementById(id);
const elements = {
  title: $('printerTitle'),
  subtitle: $('printerSubtitle'),
  checkButton: $('operatorCheckButton'),
  message: $('operatorMessage'),
  statusPanel: $('operatorStatus'),
  statusName: $('operatorStatusName'),
  connection: $('operatorConnection'),
  expectedMessage: $('operatorExpectedMessage'),
  selectedMessage: $('operatorSelectedMessage'),
  readbackExpected: $('operatorReadbackExpected'),
  readbackCurrent: $('operatorReadbackCurrent'),
  mismatchWarning: $('operatorMismatchWarning'),
  staleWarning: $('operatorStaleWarning'),
  alarmStatus: $('operatorAlarmStatus'),
  faults: $('operatorFaults'),
  dataSource: $('operatorDataSource'),
  accessLevel: $('operatorAccessLevel'),
  liveNote: $('operatorLiveNote'),
  nav: $('topNavigation'),
  expectedOutput: $('operatorExpectedOutput'),
  expectedSource: $('operatorExpectedSource'),
  trafficLight: $('operatorTrafficLight'),
  breadcrumb: $('printerBreadcrumb'),
  activeFaultPanel: $('activeFaultPanel'),
  faultHistoryList: $('faultHistoryList'),
  printerStatus: $('operatorPrinterStatus'),
  checkedAt: $('operatorCheckedAt'),
  latestAttempt: $('operatorLatestAttempt'),
  host: $('operatorHost'),
  mode: $('operatorMode'),
  model: $('operatorModel'),
  form: $('operatorSetForm'),
  controlsPanel: $('operatorControlsPanel'),
  manualDialog: $('manualMessageDialog'),
  openManualMessage: $('openManualMessage'),
  closeManualMessage: $('closeManualMessage'),
  manualReason: $('manualMessageReason'),
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
const printerId = window.location.pathname.startsWith('/printers/')
  ? decodeURIComponent(window.location.pathname.split('/').pop())
  : params.get('id');
const PREVIEW_DEBOUNCE_MS = 250;

let printer = null;
let latestStatus = null;
let messages = [];
let latestPreview = null;
let faultState = { activeFaults: [], history: [] };
let lastServerEventAt = Date.now();
let serverConnected = false;
let manualBusy = false;
let pendingManualJobId = null;
let previewTimer = null;
let previewRequestId = 0;
let operatorNoticeSticky = false;

const releaseQueue = createOperatorReleaseQueue({
  printerId,
  elements: {
    current: $('currentOperatorRelease'), next: $('nextOperatorRelease'), upcomingList: $('upcomingReleaseList'),
    upcomingButton: $('viewUpcomingReleases'), upcomingDialog: $('upcomingReleaseDialog'), upcomingClose: $('closeUpcomingReleases'),
    upcomingSearch: $('upcomingReleaseSearch'), completedSearch: $('completedReleaseSearch'),
    completedList: $('completedReleaseList'), completedButton: $('viewCompletedReleases'),
    completedDialog: $('completedReleaseDialog'), completedClose: $('closeCompletedReleases'), notice: $('operatorReleaseNotice'),
    refresh: $('refreshOperatorReleases'), dialog: $('operatorReleaseDialog'), title: $('operatorReleaseDialogTitle'),
    subtitle: $('operatorReleaseDialogSubtitle'), close: $('closeOperatorReleaseDialog'), dialogNotice: $('operatorReleaseDialogNotice'),
    progress: $('operatorReleaseProgress'), progressTitle: $('operatorReleaseProgressTitle'), progressText: $('operatorReleaseProgressText'),
    facts: $('operatorReleaseFacts'), preview: $('operatorReleasePreview'), confirmation: $('operatorReleaseConfirmation'),
    confirmCheck: $('operatorReleaseConfirmationCheck'), failureField: $('operatorPrintFailureField'), reasonLabel: $('operatorReleaseReasonLabel'),
    failureReason: $('operatorPrintFailureReason'), cancel: $('cancelOperatorRelease'), send: $('sendOperatorRelease'),
    returnRelease: $('returnOperatorRelease'), report: $('reportOperatorPrintFailure'), verify: $('verifyOperatorPrint'), endRun: $('endOperatorRun')
  },
  getPrinter: (id) => id === printerId ? printer : null,
  getStatus: (id) => id === printerId ? latestStatus : null
});

function selectedMessageDefinition() {
  return messages.find((message) => message.id === elements.messageName.value) || null;
}

function dynamicFieldInputs() {
  return [...elements.messageFields.querySelectorAll('input[data-field-key]')];
}

function setBusy(busy) {
  manualBusy = busy;
  const canOperate = printer ? canOperatePrinter(printer.id) : false;
  const disabled = busy || !printer?.enabled || !serverConnected || !canOperate;

  elements.checkButton.disabled = disabled;
  elements.setButton.disabled = disabled || !messages.length;
  elements.messageName.disabled = disabled || !messages.length;
  elements.manualReason.disabled = disabled;
  elements.openManualMessage.disabled = disabled;
  elements.confirmSetButton.disabled = disabled;
  for (const input of dynamicFieldInputs()) input.disabled = disabled;
}

function setOperatorNotice(message = '', type = 'info', { sticky = false, force = false } = {}) {
  if (!message) {
    if (force || !operatorNoticeSticky) {
      operatorNoticeSticky = false;
      setNotice(elements.message);
    }
    return;
  }
  if (force || !operatorNoticeSticky || sticky) {
    operatorNoticeSticky = sticky;
    setNotice(elements.message, message, type);
  }
}

function accessLabel() {
  if (!printer) return 'Loading';
  const session = currentSession();
  if (!canOperatePrinter(printer.id)) return 'Read-only access';
  if (session?.user?.roles?.some((role) => ['qa', 'engineering', 'admin'].includes(role))) return 'Privileged';
  return 'Operator';
}

function canSetManually() {
  return Boolean(currentSession()?.user?.roles?.some((role) => ['qa', 'engineering', 'admin'].includes(role)));
}

function updateCapabilityView() {
  const canOperate = printer ? canOperatePrinter(printer.id) : false;
  elements.accessLevel.textContent = accessLabel();
  const manualAllowed = canOperate && canSetManually();
  elements.controlsPanel.classList.toggle('hidden', !manualAllowed);
  elements.openManualMessage.classList.toggle('hidden', !manualAllowed);
  elements.checkButton.textContent = canOperate ? 'Check status' : 'Read only';
  setBusy(manualBusy);
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
  elements.controlsPanel.classList.remove('review-active');
  elements.reviewPanel.classList.add('hidden');
  clear(elements.reviewContent);
}

function closeManualDialog() {
  if (manualBusy) return;
  hideReview();
  elements.manualDialog.close();
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
      if ((field.transform || 'uppercase') === 'uppercase') {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = input.value.toUpperCase();
        input.setSelectionRange(start, end);
      }
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
      printerId,
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

function refreshManualPreviewTime() {
  if (!elements.manualDialog.open || document.hidden || !latestPreview) return;
  const definition = selectedMessageDefinition();
  const validation = validateFieldValues();
  if (!definition || !validation.valid) return;
  latestPreview = { ...latestPreview, ...messageExpectedOutput(definition, validation.fields) };
  elements.expectedPreview.textContent = latestPreview.rendered;
  const reviewPreview = elements.reviewContent.querySelector('.review-preview pre');
  if (reviewPreview) reviewPreview.textContent = latestPreview.rendered;
}

function operatorLiveNote(status, mismatch) {
  if (!status?.lastSuccessfulAt) return 'Waiting for the first successful printer update.';
  if (!serverConnected) return 'Live data lost. Showing the last successful printer state.';
  if (mismatch && status.online === false) return `Printer is offline; automatic polling continues. ${status.lastError || ''}`.trim();
  if (mismatch && isStale(status)) return `Data is stale; automatic polling continues. ${status.lastError || ''}`.trim();
  if (mismatch && Number(status.consecutiveFailures || 0) > 0) return `Latest poll failed; retrying automatically. ${status.lastError || ''}`.trim();
  if (mismatch) return 'Automatic polling continues.';
  if (status.online === false) return `Printer is offline. Automatic polling continues. ${status.lastError || ''}`.trim();
  if (isStale(status)) return `Data is stale. Automatic polling continues. ${status.lastError || ''}`.trim();
  if (Number(status.consecutiveFailures || 0) > 0) return `Latest poll failed; retrying automatically. ${status.lastError || ''}`.trim();
  return 'Live status is streaming.';
}

function mismatchStatusDetail(status) {
  if (status?.online === false) return ` Printer is offline; showing the last known mismatch. ${status.lastError || ''}`.trimEnd();
  if (status && isStale(status)) return ` Printer data is stale; showing the last known mismatch. ${status.lastError || ''}`.trimEnd();
  if (Number(status?.consecutiveFailures || 0) > 0) return ` Latest poll failed; retrying automatically. ${status.lastError || ''}`.trimEnd();
  return '';
}

function updateOperatorShell() {
  const sourceText = serverConnected ? 'Live data stream' : 'Last known status';
  const displayStatus = latestStatus
    ? { ...latestStatus, config: printer || {} }
    : { state: 'not-checked', config: printer || {} };
  const visibleBusy = isVisibleBusy(displayStatus);
  const tone = printer?.enabled ? statusTone(displayStatus) : 'disabled';
  const decodedStatus = latestStatus?.decodedStatus || null;
  const stale = latestStatus ? isStale(latestStatus) : false;
  const lightState = printerState(decodedStatus);
  const mismatch = latestStatus ? messageMismatch(printer || {}, latestStatus) : null;

  elements.statusPanel.className = `viewer-card operator-status-card status-${tone}`;
  elements.dataSource.textContent = sourceText;
  elements.liveNote.textContent = operatorLiveNote(latestStatus, mismatch);
  if (elements.mismatchWarning) {
    elements.mismatchWarning.classList.toggle('hidden', !mismatch);
    elements.mismatchWarning.textContent = mismatch ? `MESSAGE MISMATCH - Expected ${mismatch.expected}, printer reports ${mismatch.actual}.` : '';
  }
  if (elements.staleWarning) {
    elements.staleWarning.classList.toggle('hidden', !stale);
  }
  clear(elements.trafficLight);
  elements.trafficLight.appendChild(trafficLightMarkup(decodedStatus, { stale: stale || latestStatus?.online === false }));

  if (latestStatus) {
    const expectedMessage = latestStatus.expectedOutput?.printerMessageName || null;
    const selectedMessage = latestStatus.messageVerification === 'unsupported' || printer?.capabilities?.currentMessageReadback === false
      ? `Readback unavailable (${printer?.model || '1710'})`
      : latestStatus.selectedMessage || '-';
    elements.connection.textContent = statusLabel(displayStatus);
    if (elements.expectedMessage) elements.expectedMessage.textContent = expectedMessage || 'No expected message';
    elements.selectedMessage.textContent = selectedMessage;
    if (elements.readbackExpected) elements.readbackExpected.textContent = expectedMessage || 'No expected message';
    if (elements.readbackCurrent) elements.readbackCurrent.textContent = selectedMessage;
    elements.alarmStatus.textContent = lightState.label;
    elements.faults.textContent = faultSummary(latestStatus.decodedStatus);
    elements.printerStatus.textContent = latestStatus.rawStatus || latestStatus.status || '-';
    elements.checkedAt.textContent = formatDateTime(latestStatus.lastSuccessfulAt);
    if (elements.latestAttempt) elements.latestAttempt.textContent = latestStatus.lastAttemptAt ? formatDateTime(latestStatus.lastAttemptAt) : 'No attempt yet';
    renderExpectedOutput(latestStatus.expectedOutput);

    if (mismatch) {
      const mismatchDetail = mismatchStatusDetail(latestStatus);
      setOperatorNotice(`MESSAGE MISMATCH - STOP PRODUCTION. Expected ${mismatch.expected}, printer reports ${mismatch.actual}.${mismatchDetail} Stop the line, quarantine product since the mismatch was detected, then resend the release and reverify the first print.`, 'error', { sticky: true, force: true });
    } else if (latestStatus.online === false && serverConnected) {
      const errorDetail = latestStatus.lastError ? ` Latest printer error: ${latestStatus.lastError}` : '';
      setOperatorNotice(`Printer is offline. Automatic polling continues.${errorDetail}`, 'error', { force: true });
    } else if (isStale(latestStatus) && serverConnected) {
      const errorDetail = latestStatus.lastError ? ` Latest WSI error: ${latestStatus.lastError}` : '';
      setOperatorNotice(`Printer status is stale. Waiting for a fresh server update.${errorDetail}`, 'error', { force: true });
    } else if (serverConnected) {
      setOperatorNotice('', 'info', { force: true });
    }
  } else if (printer && !printer.enabled) {
    elements.connection.textContent = 'Disabled';
    if (elements.expectedMessage) elements.expectedMessage.textContent = '-';
    elements.selectedMessage.textContent = '-';
    if (elements.readbackExpected) elements.readbackExpected.textContent = '-';
    if (elements.readbackCurrent) elements.readbackCurrent.textContent = '-';
    elements.alarmStatus.textContent = '-';
    elements.faults.textContent = 'Coder is disabled';
    elements.checkedAt.textContent = 'No update yet';
    if (elements.latestAttempt) elements.latestAttempt.textContent = 'No attempt yet';
    renderExpectedOutput(null);
  }

  setBusy(visibleBusy || manualBusy);
}

function renderExpectedOutput(expectedOutput) {
  if (!elements.expectedOutput || !elements.expectedSource) return;
  if (!expectedOutput?.rendered) {
    elements.expectedOutput.textContent = 'No expected output recorded';
    elements.expectedSource.textContent = 'Set a message to record expected output.';
    return;
  }

  elements.expectedOutput.textContent = expectedOutputText(expectedOutput, printerId);
  elements.expectedSource.textContent = expectedOutput.source === 'last-known'
    ? 'Last expected output'
    : 'Physical print check: Required';
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '-' : date.toLocaleString();
}

function activeFaultRecord(fault) {
  const stored = faultState.activeFaults.find((item) => item.faultCode === fault.code);
  return {
    ...fault,
    faultCode: fault.code,
    faultLabel: fault.label,
    activatedAt: stored?.activatedAt || stored?.occurredAt || null
  };
}

function renderActiveFaults() {
  clear(elements.activeFaultPanel);
  const faults = activeFaults(latestStatus?.decodedStatus).map(activeFaultRecord);
  if (!faults.length) {
    elements.activeFaultPanel.appendChild(el('p', { className: 'muted', text: 'No active printer faults' }));
    return;
  }

  const now = Date.now();
  for (const fault of faults) {
    const activatedAtMs = fault.activatedAt ? new Date(fault.activatedAt).valueOf() : NaN;
    const durationMs = Number.isFinite(activatedAtMs) ? now - activatedAtMs : null;
    elements.activeFaultPanel.appendChild(el('article', { className: 'fault-item' }, [
      el('h3', { text: fault.faultLabel || fault.label }),
      el('div', { className: 'coder-meta' }, [
        el('div', { className: 'detail' }, [el('span', { text: 'Code' }), el('strong', { text: fault.faultCode || fault.code })]),
        el('div', { className: 'detail' }, [el('span', { text: 'Fault byte' }), el('strong', { text: String(fault.byte || '-') })]),
        el('div', { className: 'detail' }, [el('span', { text: 'Bit value' }), el('strong', { text: String(fault.bit || '-') })]),
        el('div', { className: 'detail' }, [el('span', { text: 'First observed' }), el('strong', { text: formatDateTime(fault.activatedAt) })]),
        el('div', { className: 'detail' }, [el('span', { text: 'Duration' }), el('strong', { text: formatDuration(durationMs) })])
      ])
    ]));
  }
}

function renderFaultHistory() {
  clear(elements.faultHistoryList);
  if (!faultState.history.length) {
    elements.faultHistoryList.appendChild(el('p', { className: 'muted', text: 'No fault history recorded.' }));
    return;
  }

  for (const event of faultState.history.slice(0, 50)) {
    const label = `${formatDateTime(event.occurredAt)}  ${event.faultLabel} ${event.event}`;
    const duration = event.durationMs !== undefined && event.durationMs !== null
      ? `  Duration ${formatDuration(event.durationMs)}`
      : '';
    elements.faultHistoryList.appendChild(el('article', { className: 'fault-history-item' }, [
      el('strong', { text: `${label}${duration}` }),
      el('span', { className: 'muted', text: event.faultCode })
    ]));
  }
}

function renderFaultPanels() {
  renderActiveFaults();
  renderFaultHistory();
}

function applyPrinterConfig(value) {
  printer = value;
  elements.title.textContent = printer.name;
  if (elements.statusName) elements.statusName.textContent = printer.name;
  elements.subtitle.textContent = printer.location || 'No location set';
  elements.breadcrumb.textContent = `Dashboard / ${printer.name}`;
  elements.host.textContent = `${printer.host}:${printer.port}`;
  elements.mode.textContent = printer.mode === 'emulator' ? 'Emulator' : 'Real printer';
  elements.model.textContent = `Videojet ${printer.model || '1620'}`;
  if (window.location.pathname !== printerHref(printer.id) && window.location.pathname.startsWith('/printers/')) {
    window.history.replaceState(null, '', printerHref(printer.id));
  }

  if (!printer.enabled) {
    setOperatorNotice(`${printer.name} is disabled.`, 'error', { sticky: true });
  }

  updateOperatorShell();
  updateCapabilityView();
  renderFaultPanels();
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
    expectedOutput: value.expectedOutput || latestStatus?.expectedOutput || null,
    messageVerification: value.messageVerification || latestStatus?.messageVerification || null,
    lastSuccessfulAt: value.lastSuccessfulAt || latestStatus?.lastSuccessfulAt || null,
    busy: visibleBusy,
    currentOperation: visibleBusy ? value.currentOperation || null : null
  };

  if (value.ok === false && !value.messageMatches) {
    setOperatorNotice(value.operatorMessage || value.error || 'Printer request failed.', 'error', { sticky: true });
  } else if (visibleBusy) {
    setOperatorNotice('Printer operation in progress...', 'info', { force: true });
  } else if (serverConnected && !isStale(latestStatus)) {
    setOperatorNotice();
  }

  updateOperatorShell();
  releaseQueue.rerender();
}

async function loadMessages() {
  if (!printerId || !canOperatePrinter(printerId)) return;
  messages = await apiJson(`/api/printers/${encodeURIComponent(printerId)}/messages`);
  renderMessageOptions();
}

async function loadPrinter() {
  if (!printerId) {
    setOperatorNotice('No coder id was provided in the page URL.', 'error', { sticky: true });
    setBusy(true);
    return;
  }

  try {
    await loadSession();
    renderNavigation(elements.nav, { active: window.location.pathname });
    applyPrinterConfig(await apiJson(`/api/printers/${encodeURIComponent(printerId)}`));
    if (canOperatePrinter(printerId)) await loadMessages();
    await releaseQueue.load();
    const cached = await apiJson(`/api/printers/${encodeURIComponent(printerId)}/status`);
    applyPrinterStatus(cached);
    await loadFaultHistory();
  } catch (error) {
    setOperatorNotice(normalizeError(error), 'error', { sticky: true });
    setBusy(true);
  }
}

async function loadFaultHistory() {
  if (!printerId) return;
  const data = await apiJson(`/api/printers/${encodeURIComponent(printerId)}/faults?limit=50`);
  faultState = {
    activeFaults: Array.isArray(data.activeFaults) ? data.activeFaults : [],
    history: Array.isArray(data.history) ? data.history : []
  };
  renderFaultPanels();
}

function applyFaultEvent(event) {
  if (!event || event.printerId !== printerId) return;
  faultState.history = [event, ...faultState.history.filter((item) => item.id !== event.id)].slice(0, 50);
  if (event.event === 'activated') {
    faultState.activeFaults = [
      {
        printerId: event.printerId,
        faultCode: event.faultCode,
        faultLabel: event.faultLabel,
        byte: event.byte,
        bit: event.bit,
        activatedAt: event.occurredAt,
        rawStatus: event.rawStatus
      },
      ...faultState.activeFaults.filter((item) => item.faultCode !== event.faultCode)
    ];
  } else if (event.event === 'cleared') {
    faultState.activeFaults = faultState.activeFaults.filter((item) => item.faultCode !== event.faultCode);
  }
  renderFaultPanels();
}

async function checkPrinter() {
  if (!printer || !printer.enabled || !serverConnected || !canOperatePrinter(printer.id)) return;

  setBusy(true);
  setOperatorNotice('Checking coder...', 'info', { force: true });
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
  elements.controlsPanel.classList.add('review-active');
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
  if (!printer || !printer.enabled || !serverConnected || manualBusy || !canOperatePrinter(printer.id)) return;

  const reason = elements.manualReason.value.trim();
  if (reason.length < 5) {
    setOperatorNotice('Enter a clear reason for this manual message change.', 'error', { force: true });
    return;
  }
  const preview = await refreshPreviewNow();
  if (!preview) {
    setOperatorNotice('Enter all required fields before reviewing this update.', 'error', { force: true });
    return;
  }

  setOperatorNotice('', 'info', { force: true });
  renderReview(preview);
  appendReviewLine('Audit reason', reason);
}

function fieldResultLine(result) {
  return `${result.printerFieldName} update: ${result.acknowledged ? 'Acknowledged' : 'Failed'}`;
}

function showUpdateResult(result) {
  const requestedMessage = result.requestedMessage || result.expectedMessage || result.expectedOutput?.printerMessageName;
  const actualMismatch = Boolean(requestedMessage && result.selectedMessage && result.selectedMessage !== requestedMessage);

  if (result.ok && result.verificationAvailable === false) {
    applyPrinterStatus(result);
    const fieldLines = (result.fieldResults || []).map(fieldResultLine).join('\n');
    setOperatorNotice(
      `Message change acknowledged by the printer\n\nCurrent-message readback is unavailable on Videojet ${printer?.model || '1710'}.\n${fieldLines}\nPhysical print check: Required`,
      'success',
      { sticky: true }
    );
    return;
  }
  if (result.ok && result.messageMatches) {
    applyPrinterStatus(result);
  } else if (result.status) {
    applyPrinterStatus({
      ok: true,
      printerId: result.printerId || printerId,
      online: result.status.online,
      stale: result.status.stale,
      selectedMessage: result.status.selectedMessage || result.selectedMessage,
      rawStatus: result.status.rawStatus,
      decodedStatus: result.status.decodedStatus,
      expectedOutput: result.status.expectedOutput,
      lastSuccessfulAt: result.status.lastSuccessfulAt,
      consecutiveFailures: result.status.consecutiveFailures,
      lastError: result.status.lastError
    });
  }

  if (result.ok && result.messageMatches) {
    const fieldLines = (result.fieldResults || []).map(fieldResultLine).join('\n');
    setOperatorNotice(
      `Printer updated successfully\n\nSelected message: Verified\n${fieldLines}\nPhysical print check: Required`,
      'success',
      { sticky: true }
    );
    return;
  }

  if (actualMismatch || result.code === 'MESSAGE_MISMATCH') {
    setOperatorNotice(
      requestedMessage
        ? `MESSAGE MISMATCH\n\nRequested: ${requestedMessage}\nPrinter reports: ${result.selectedMessage || 'nothing'}\n\nDo not start production.`
        : `Printer state changed unexpectedly\n\nPrinter reports: ${result.selectedMessage}\n\nRefresh and review the requested message before production.`,
      'error',
      { sticky: true }
    );
    return;
  }

  const fieldLines = (result.fieldResults || []).map((field) =>
    `${field.printerFieldName}: ${field.acknowledged ? 'Acknowledged' : 'Failed'}`
  ).join('\n');
  const selectedLine = result.selectedMessage
    ? `\nSelected message: ${actualMismatch ? result.selectedMessage : 'Verified'}`
    : '';
  setOperatorNotice(
    `${result.operatorMessage || 'Message update failed'}\n\n${fieldLines}\nMessage selection: ${result.messageSelection || 'Not attempted'}${selectedLine}`,
    'error',
    { sticky: true }
  );
}

async function confirmPrinterUpdate() {
  if (!printer || !printer.enabled || !serverConnected || manualBusy || !canOperatePrinter(printer.id)) return;

  const definition = selectedMessageDefinition();
  const reason = elements.manualReason.value.trim();
  const validation = validateFieldValues();
  setFieldErrors(validation.errors);
  if (!definition || !validation.valid || reason.length < 5) {
    setOperatorNotice('Enter all required fields before setting the printer.', 'error', { force: true });
    return;
  }

  hideReview();
  elements.manualDialog.close();
  setBusy(true);
  setOperatorNotice('Queued message request...', 'info', { force: true });
  try {
    const result = await postJson(`/api/printers/${encodeURIComponent(printerId)}/set`, {
      messageId: definition.id,
      fields: validation.fields,
      reason,
      expectedRevision: latestStatus?.revision
    });
    elements.manualReason.value = '';
    if (result.queued) {
      pendingManualJobId = result.job?.id || null;
      setOperatorNotice('Manual change queued. Waiting for the printer agent to verify it.', 'info', { force: true });
      return;
    }
    showUpdateResult(result);
    if (result.verificationAvailable !== false && printer?.capabilities?.currentMessageReadback !== false) {
      try {
        const readback = await apiJson(`/api/printer/current-message?printerId=${encodeURIComponent(printerId)}`);
        applyPrinterStatus({
          printerId,
          selectedMessage: readback.currentMessage,
          checkedAt: readback.checkedAt
        });
        const requestedMessage = result.requestedMessage || definition.printerMessageName;
        if (readback.currentMessage !== requestedMessage) {
          setOperatorNotice(
            `MESSAGE MISMATCH\n\nRequested: ${requestedMessage}\nPrinter reports: ${readback.currentMessage}\n\nDo not start production.`,
            'error',
            { sticky: true }
          );
        } else {
          showUpdateResult(result);
        }
      } catch (readbackError) {
        setOperatorNotice(`Message change sent, but readback failed: ${normalizeError(readbackError)}`, 'error', { sticky: true });
      }
    }
  } catch (error) {
    hideReview();
    if (error.data?.fieldResults || (error.data?.selectedMessage && error.data?.requestedMessage)) showUpdateResult(error.data);
    else {
      setOperatorNotice(error.data?.operatorMessage || normalizeError(error), 'error', { sticky: true });
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
  setOperatorNotice('Server disconnected. Showing the last known printer status.', 'error', { force: true });
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
elements.openManualMessage.addEventListener('click', () => {
  setOperatorNotice('', 'info', { force: true });
  hideReview();
  if (!elements.manualDialog.open) elements.manualDialog.showModal();
});
elements.closeManualMessage.addEventListener('click', () => {
  closeManualDialog();
});
elements.manualDialog.addEventListener('click', (event) => {
  if (event.target === elements.manualDialog) closeManualDialog();
});
elements.manualDialog.addEventListener('cancel', (event) => {
  if (manualBusy) event.preventDefault();
});

subscribeToPrinterEvents({
  onConnected: markServerConnected,
  onHeartbeat: markServerConnected,
  onDisconnected: markServerDisconnected,

  onPrinterStatus: (value) => {
    markServerConnected();
    applyPrinterStatus(value);
    if (pendingManualJobId && value.operationId === pendingManualJobId) {
      pendingManualJobId = null;
      showUpdateResult(value);
    }
  },

  onOperationFailed: (value) => {
    markServerConnected();
    const id = value.id || value.printerId;
    if (id === printerId && value.fieldResults) showUpdateResult(value);
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

  onFaultActivated: (value) => {
    markServerConnected();
    applyFaultEvent(value);
  },

  onFaultCleared: (value) => {
    markServerConnected();
    applyFaultEvent(value);
  },

  onFleetSnapshot: (printers) => {
    markServerConnected();

    const match = printers.find((value) => value.id === printerId);
    if (match) {
      applyPrinterConfig(match);
      loadMessages().catch((error) => setOperatorNotice(normalizeError(error), 'error', { sticky: true }));
    }
  },
  onBatchReleaseExecution: () => releaseQueue.refresh().catch((error) => setOperatorNotice(normalizeError(error), 'error', { sticky: true })),
  onBatchReleaseChanged: () => releaseQueue.refresh().catch((error) => setOperatorNotice(normalizeError(error), 'error', { sticky: true }))
});

loadPrinter();
setInterval(() => {
  const age = Date.now() - lastServerEventAt;
  if (age > 45000) markServerDisconnected();
}, 5000);
setInterval(refreshManualPreviewTime, 1000);
setInterval(updateOperatorShell, 1000);

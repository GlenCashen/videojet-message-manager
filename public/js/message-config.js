import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';
import { messageExpectedOutput } from './release-preview.js';

let messages = [];
let printers = [];
let userFields = [];
let productMasters = [];
let selectedId = null;
let creating = false;
let idTouched = false;
let displayNameTouched = false;
let activeLine = null;
let editingUserFieldId = null;
let userFieldNameTouched = false;
let livePreviewClock = null;

function slug(value, fallback = '') {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || fallback;
}

function partialSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 50);
}

function fieldKey(value) {
  const key = slug(value, 'field').slice(0, 30);
  return /^[a-z]/.test(key) ? key : `field-${key}`.slice(0, 30);
}

function printerFieldName(value) {
  return String(value || '').replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 30);
}

function selectedMessage() {
  return messages.find((message) => message.id === selectedId) || null;
}

function assignmentFor(message) {
  return message?.printerAssignments?.[0] || null;
}

function printerById(id) {
  return printers.find((printer) => printer.id === id) || null;
}

function fieldsForPrinter(printerId) {
  return userFields.filter((field) => field.printerId === printerId);
}

function renderPrinterOptions() {
  const currentRegistryPrinter = elements.userFieldPrinter.value;
  const currentMessagePrinter = elements.messagePrinter.value;
  clear(elements.userFieldPrinter);
  clear(elements.messagePrinter);
  for (const printer of printers) {
    const option = () => el('option', { value: printer.id, text: printer.enabled ? printer.name : `${printer.name} (disabled)` });
    elements.userFieldPrinter.appendChild(option());
    elements.messagePrinter.appendChild(option());
  }
  elements.userFieldPrinter.value = currentRegistryPrinter || assignmentFor(selectedMessage())?.printerId || printers[0]?.id || '';
  elements.messagePrinter.value = currentMessagePrinter || elements.userFieldPrinter.value;
}

function renderMessageList() {
  clear(elements.messageList);
  for (const printer of printers) {
    const assigned = messages.filter((message) => assignmentFor(message)?.printerId === printer.id);
    const group = el('section', { className: 'message-printer-group' }, [
      el('div', { className: 'message-printer-group-heading' }, [
        el('strong', { text: printer.name }),
        el('span', { text: String(assigned.length) })
      ])
    ]);
    if (!assigned.length) group.appendChild(el('p', { className: 'muted', text: 'No messages.' }));
    for (const message of assigned) {
      group.appendChild(el('button', {
        type: 'button',
        className: message.id === selectedId ? 'message-list-item active' : 'message-list-item',
        dataset: { id: message.id }
      }, [
        el('strong', { text: message.displayName }),
        el('span', { text: `${assignmentFor(message).printerMessageName} · ${message.enabled ? 'Enabled' : 'Disabled'}` })
      ]));
    }
    elements.messageList.appendChild(group);
  }
}

function renderMessageMasterUsage(message = selectedMessage()) {
  clear(elements.messageMasterUsageList);
  const usedBy = message ? productMasters.filter((master) => (master.specification?.printerConfigurations || [])
    .some((configuration) => configuration.messageId === message.id)) : [];
  elements.messageMasterUsageCount.textContent = String(usedBy.length);
  elements.messageMasterUsage.open = false;
  if (!usedBy.length) {
    elements.messageMasterUsageList.appendChild(el('p', { className: 'muted', text: 'No current product masters use this message.' }));
    return;
  }
  for (const master of usedBy) {
    const batchCode = master.specification?.defaultBrewSheetProduct || master.productCode;
    const href = `/production-releases?masterSearch=${encodeURIComponent(master.productCode)}#masters`;
    elements.messageMasterUsageList.appendChild(el('a', { className: 'message-master-link', href }, [
      el('strong', { text: `${master.productCode} - ${batchCode}` }),
      el('span', { text: master.displayName })
    ]));
  }
}

function selectedFieldIds() {
  return [...elements.messageFieldChoices.querySelectorAll('[data-message-user-field]:checked')]
    .map((input) => input.value);
}

function selectedFields() {
  const ids = new Set(selectedFieldIds());
  return userFields.filter((field) => ids.has(field.id));
}

function renderMessageFieldChoices(message = selectedMessage()) {
  clear(elements.messageFieldChoices);
  const printerId = elements.messagePrinter.value;
  const available = fieldsForPrinter(printerId);
  const selected = new Set((message?.fields || []).map((field) => field.userFieldId).filter(Boolean));
  if (!available.length) {
    elements.messageFieldChoices.appendChild(el('p', { className: 'no-message-fields', text: 'This printer has no user fields. Create them in Printer user fields above.' }));
  }
  for (const field of available) {
    elements.messageFieldChoices.appendChild(el('label', { className: 'message-field-choice' }, [
      el('input', { type: 'checkbox', value: field.id, checked: selected.has(field.id) ? 'checked' : null, dataset: { messageUserField: 'true' } }),
      el('span', {}, [
        el('strong', { text: field.label }),
        el('small', { text: `${field.printerFieldName} · {{${field.key}}}` })
      ])
    ]));
  }
  renderTokenPalette();
  updateSuggestedName();
}

function lineValues() {
  return [...elements.messageLineBuilder.querySelectorAll('[data-message-line]')].map((input) => input.value);
}

function insertToken(input, token) {
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`;
  input.focus();
  input.setSelectionRange(start + token.length, start + token.length);
  activeLine = input;
  renderLivePreview();
  updateSuggestedName();
}

function renderLineBuilder(lines = lineValues()) {
  const count = Number(elements.messageLineCount.value || 2);
  clear(elements.messageLineBuilder);
  for (let index = 0; index < count; index += 1) {
    const input = el('input', {
      value: lines[index] || '', maxlength: '200', autocomplete: 'off', placeholder: 'Type fixed text, then insert fields above',
      dataset: { messageLine: String(index) }, 'aria-label': `Expected print line ${index + 1}`
    });
    input.addEventListener('focus', () => { activeLine = input; });
    input.addEventListener('dragover', (event) => event.preventDefault());
    input.addEventListener('drop', (event) => {
      event.preventDefault();
      const token = event.dataTransfer.getData('text/plain');
      if (token) insertToken(input, token);
    });
    elements.messageLineBuilder.appendChild(el('label', { className: 'message-line-row' }, [el('span', { text: `Line ${index + 1}` }), input]));
  }
  activeLine = elements.messageLineBuilder.querySelector('[data-message-line]');
  renderLivePreview();
  updateSuggestedName();
}

function renderTokenPalette() {
  clear(elements.messageTokenPalette);
  const tokens = selectedFields().map((field) => ({ key: field.key, label: field.label }));
  tokens.push({ key: 'bestBeforeDate', label: 'Best-before date' }, { key: 'currentTime', label: 'Production time' });
  for (const token of tokens) {
    const value = `{{${token.key}}}`;
    const button = el('button', { className: 'message-token', type: 'button', draggable: 'true', dataset: { messageToken: value }, text: token.label });
    button.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', value));
    elements.messageTokenPalette.appendChild(button);
  }
}

function dateOffsetDays(rule) {
  if (rule?.type === 'offset-days') return Number(rule.days ?? rule.months ?? 0);
  return Number(rule?.months ?? 0) * 30;
}

function renderLivePreview() {
  const fields = selectedFields();
  const values = Object.fromEntries(fields.map((field) => [field.key, `[${field.label}]`]));
  const previewLines = lineValues();
  if (!previewLines.some(Boolean)) {
    elements.messageDefinitionPreview.textContent = 'Build the expected print lines above.';
    return;
  }
  const preview = messageExpectedOutput({
    id: elements.messageConfigId.value || 'draft-message',
    displayName: elements.messageDisplayName.value || 'Draft message',
    printerMessageName: elements.messagePrinterName.value || '',
    fields,
    previewLines,
    dateRule: { type: 'offset-days', days: Number(elements.messageDateMonths.value || 0), format: elements.messageDateFormat.value || 'DD/MM/YYYY' },
    timeRule: { format: elements.messageTimeFormat.value || 'HH:mm:ss' }
  }, values);
  elements.messageDefinitionPreview.textContent = preview.rendered;
}

function suggestedDisplayName() {
  const days = Number(elements.messageDateMonths.value || 0);
  const dayLabel = days ? `${days}D` : 'TODAY';
  const descriptors = selectedFields().map((field) => field.key.toUpperCase());
  if (!descriptors.length) {
    if (lineValues().some((line) => line.includes('{{bestBeforeDate}}'))) descriptors.push('DATE');
    if (lineValues().some((line) => line.includes('{{currentTime}}'))) descriptors.push('TIME');
  }
  return `${dayLabel} ${elements.messageLineCount.value || 1} line ${descriptors.join('/') || 'STATIC'}`;
}

function updateMessageActionButtons(message = selectedMessage()) {
  const selected = Boolean(message);
  elements.archiveMessageButton.classList.toggle('hidden', !selected);
  elements.deleteMessageButton.classList.toggle('hidden', !selected || message.enabled);
  elements.archiveMessageButton.textContent = message?.enabled ? 'Archive message' : 'Restore message';
}

function updateSuggestedName() {
  if (!creating || displayNameTouched) return;
  elements.messageDisplayName.value = suggestedDisplayName();
  if (!idTouched) elements.messageConfigId.value = slug(`${elements.messagePrinter.value}-${elements.messageDisplayName.value}`);
}

function populateForm(message) {
  const assignment = assignmentFor(message);
  selectedId = message.id;
  creating = false;
  idTouched = true;
  displayNameTouched = true;
  elements.messageForm.classList.remove('hidden');
  elements.messagePrinter.disabled = true;
  elements.messagePrinter.value = assignment.printerId;
  elements.messagePrinterName.value = assignment.printerMessageName;
  elements.messageConfigId.readOnly = true;
  elements.messageConfigId.value = message.id;
  elements.messageDisplayName.value = message.displayName;
  elements.messageEnabled.checked = message.enabled;
  elements.messageDateMonths.value = String(dateOffsetDays(message.dateRule));
  elements.messageDateFormat.value = message.dateRule?.format || 'DD/MM/YYYY';
  elements.messageTimeFormat.value = message.timeRule?.format || 'HH:mm:ss';
  elements.messageLineCount.value = String(Math.min(Math.max(message.previewLines?.length || 2, 1), 4));
  renderMessageFieldChoices(message);
  renderLineBuilder(message.previewLines || []);
  renderMessageMasterUsage(message);
  renderMessageList();
  updateMessageActionButtons(message);
}

function startNewMessage() {
  creating = true;
  selectedId = null;
  idTouched = false;
  displayNameTouched = false;
  elements.messageForm.classList.remove('hidden');
  elements.messagePrinter.disabled = false;
  elements.messagePrinter.value = elements.userFieldPrinter.value || printers[0]?.id || '';
  elements.messagePrinterName.value = '';
  elements.messageConfigId.readOnly = false;
  elements.messageConfigId.value = '';
  elements.messageDisplayName.value = '';
  elements.messageEnabled.checked = true;
  elements.messageDateMonths.value = '0';
  elements.messageDateFormat.value = 'DD/MM/YYYY';
  elements.messageTimeFormat.value = 'HH:mm:ss';
  elements.messageLineCount.value = '2';
  renderMessageFieldChoices(null);
  renderLineBuilder(['', '']);
  renderMessageMasterUsage(null);
  renderMessageList();
  updateMessageActionButtons(null);
  elements.messagePrinterName.focus();
}

async function saveMessage(event) {
  event.preventDefault();
  const message = selectedMessage();
  if (!message && !creating) return;
  elements.saveMessageButton.disabled = true;
  setNotice(elements.messageConfigMessage, 'Saving message...');
  try {
    const previewLines = lineValues().map((line) => line.trimEnd());
    if (previewLines.some((line) => !line.trim())) throw new Error('Every configured print line needs content.');
    const payload = {
      id: slug(elements.messageConfigId.value),
      displayName: elements.messageDisplayName.value.trim(),
      enabled: elements.messageEnabled.checked,
      fieldIds: selectedFieldIds(),
      dateRule: { type: 'offset-days', days: Number(elements.messageDateMonths.value), format: elements.messageDateFormat.value },
      timeRule: { type: 'production-time', format: elements.messageTimeFormat.value },
      previewLines,
      printerAssignments: [{ printerId: elements.messagePrinter.value, printerMessageName: elements.messagePrinterName.value.trim(), enabled: true }]
    };
    const data = await apiJson(creating ? '/api/messages' : `/api/messages/${encodeURIComponent(message.id)}`, {
      method: creating ? 'POST' : 'PUT', body: payload
    });
    const index = messages.findIndex((item) => item.id === data.message.id);
    if (index >= 0) messages[index] = data.message;
    else messages.push(data.message);
    populateForm(data.message);
    window.dispatchEvent(new CustomEvent('messages-saved', { detail: data.message }));
    setNotice(elements.messageConfigMessage, `${data.message.displayName} saved.`, 'success');
  } catch (error) {
    setNotice(elements.messageConfigMessage, normalizeError(error), 'error');
  } finally {
    elements.saveMessageButton.disabled = false;
  }
}

async function archiveSelectedMessage() {
  const message = selectedMessage();
  if (!message) return;
  const nextEnabled = !message.enabled;
  if (!nextEnabled && !window.confirm(`Archive ${message.displayName}? Existing release history is retained.`)) return;
  elements.archiveMessageButton.disabled = true;
  try {
    const data = await apiJson(`/api/messages/${encodeURIComponent(message.id)}`, {
      method: 'PUT',
      body: { ...message, enabled: nextEnabled }
    });
    const index = messages.findIndex((item) => item.id === data.message.id);
    if (index >= 0) messages[index] = data.message;
    populateForm(data.message);
    window.dispatchEvent(new CustomEvent('messages-saved', { detail: data.message }));
    setNotice(elements.messageConfigMessage, `${data.message.displayName} ${nextEnabled ? 'restored' : 'archived'}.`, 'success');
  } catch (error) {
    setNotice(elements.messageConfigMessage, normalizeError(error), 'error');
  } finally {
    elements.archiveMessageButton.disabled = false;
  }
}

async function deleteSelectedMessage() {
  const message = selectedMessage();
  if (!message || message.enabled) return;
  if (!window.confirm(`Permanently delete archived message ${message.displayName}?`)) return;
  elements.deleteMessageButton.disabled = true;
  try {
    await apiJson(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' });
    messages = messages.filter((item) => item.id !== message.id);
    selectedId = messages[0]?.id || null;
    renderMessageList();
    if (selectedId) populateForm(selectedMessage());
    else {
      elements.messageForm.classList.add('hidden');
      updateMessageActionButtons(null);
    }
    window.dispatchEvent(new CustomEvent('messages-saved', { detail: null }));
    setNotice(elements.messageConfigMessage, `${message.displayName} deleted.`, 'success');
  } catch (error) {
    setNotice(elements.messageConfigMessage, normalizeError(error), 'error');
  } finally {
    elements.deleteMessageButton.disabled = false;
  }
}

function resetUserFieldForm() {
  editingUserFieldId = null;
  userFieldNameTouched = false;
  elements.printerUserFieldForm.reset();
  elements.printerUserFieldLabel.disabled = false;
  elements.printerUserFieldLabel.value = '';
  elements.printerUserFieldName.value = '';
  elements.printerUserFieldMaxLength.value = '30';
  elements.printerUserFieldUppercase.checked = true;
  elements.printerUserFieldRequired.checked = true;
  elements.printerUserFieldForm.classList.add('hidden');
}

function editUserField(field) {
  editingUserFieldId = field.id;
  userFieldNameTouched = true;
  elements.printerUserFieldLabel.value = field.label;
  elements.printerUserFieldLabel.disabled = false;
  elements.printerUserFieldName.value = field.printerFieldName;
  elements.printerUserFieldMaxLength.value = String(field.maxLength);
  elements.printerUserFieldUppercase.checked = field.transform !== 'none';
  elements.printerUserFieldRequired.checked = field.required;
  elements.printerUserFieldForm.classList.remove('hidden');
  elements.printerUserFieldLabel.focus();
}

function renderPrinterUserFields() {
  clear(elements.printerUserFieldList);
  const fields = fieldsForPrinter(elements.userFieldPrinter.value);
  if (!fields.length) elements.printerUserFieldList.appendChild(el('p', { className: 'muted', text: 'No user fields assigned to this printer.' }));
  for (const field of fields) {
    elements.printerUserFieldList.appendChild(el('article', { className: 'printer-user-field-card' }, [
      el('div', {}, [el('strong', { text: field.label }), el('span', { text: `${field.printerFieldName} · {{${field.key}}} · max ${field.maxLength}` })]),
      el('div', { className: 'actions' }, [
        el('button', { className: 'ghost', type: 'button', text: 'Edit', dataset: { editUserField: field.id } }),
        el('button', { className: 'ghost danger-text', type: 'button', text: 'Delete', dataset: { deleteUserField: field.id } })
      ])
    ]));
  }
}

async function saveUserField(event) {
  event.preventDefault();
  const label = elements.printerUserFieldLabel.value.trim();
  const storedField = printerFieldName(elements.printerUserFieldName.value || label);
  const payload = {
    label,
    ...(editingUserFieldId ? {} : { key: fieldKey(label) }),
    printerFieldName: storedField,
    maxLength: Number(elements.printerUserFieldMaxLength.value),
    transform: elements.printerUserFieldUppercase.checked ? 'uppercase' : 'none',
    required: elements.printerUserFieldRequired.checked
  };
  try {
    const path = editingUserFieldId
      ? `/api/printer-user-fields/${encodeURIComponent(editingUserFieldId)}`
      : `/api/printers/${encodeURIComponent(elements.userFieldPrinter.value)}/user-fields`;
    const data = await apiJson(path, { method: editingUserFieldId ? 'PUT' : 'POST', body: payload });
    const index = userFields.findIndex((field) => field.id === data.field.id);
    if (index >= 0) userFields[index] = data.field;
    else userFields.push(data.field);
    resetUserFieldForm();
    renderPrinterUserFields();
    if (elements.messagePrinter.value === data.field.printerId) renderMessageFieldChoices(selectedMessage());
    setNotice(elements.messageConfigMessage, `${data.field.label} saved for ${printerById(data.field.printerId)?.name}.`, 'success');
  } catch (error) {
    setNotice(elements.messageConfigMessage, normalizeError(error), 'error');
  }
}

async function deleteUserField(id) {
  const field = userFields.find((item) => item.id === id);
  if (!field || !window.confirm(`Delete ${field.label} from ${printerById(field.printerId)?.name}?`)) return;
  try {
    await apiJson(`/api/printer-user-fields/${encodeURIComponent(id)}`, { method: 'DELETE' });
    userFields = userFields.filter((item) => item.id !== id);
    renderPrinterUserFields();
    renderMessageFieldChoices(selectedMessage());
    setNotice(elements.messageConfigMessage, `${field.label} deleted.`, 'success');
  } catch (error) {
    setNotice(elements.messageConfigMessage, normalizeError(error), 'error');
  }
}

async function loadMessageConfig() {
  setNotice(elements.messageConfigMessage, 'Loading messages...');
  try {
    [messages, printers, userFields, productMasters] = await Promise.all([
      apiJson('/api/messages'), apiJson('/api/printers'), apiJson('/api/printer-user-fields'), apiJson('/api/product-masters')
    ]);
    const next = selectedMessage() || messages[0] || null;
    renderPrinterOptions();
    renderPrinterUserFields();
    renderMessageList();
    if (next) populateForm(next);
    else {
      elements.messageForm.classList.add('hidden');
      updateMessageActionButtons(null);
    }
    setNotice(elements.messageConfigMessage);
  } catch (error) {
    setNotice(elements.messageConfigMessage, normalizeError(error), 'error');
  }
}

function setupMessageConfig() {
  elements.newMessageButton.addEventListener('click', startNewMessage);
  elements.messageList.addEventListener('click', (event) => {
    const message = messages.find((item) => item.id === event.target.closest('[data-id]')?.dataset.id);
    if (message) populateForm(message);
  });
  elements.messagePrinter.addEventListener('change', () => {
    renderMessageFieldChoices(null);
    updateSuggestedName();
  });
  elements.messageFieldChoices.addEventListener('change', () => {
    renderTokenPalette();
    renderLivePreview();
    updateSuggestedName();
  });
  elements.messageTokenPalette.addEventListener('click', (event) => {
    const button = event.target.closest('[data-message-token]');
    if (button) insertToken(activeLine || elements.messageLineBuilder.querySelector('[data-message-line]'), button.dataset.messageToken);
  });
  elements.messageLineCount.addEventListener('change', () => renderLineBuilder());
  elements.messageLineBuilder.addEventListener('input', () => { renderLivePreview(); updateSuggestedName(); });
  elements.messageDateMonths.addEventListener('input', () => { renderLivePreview(); updateSuggestedName(); });
  elements.messageDateFormat.addEventListener('change', renderLivePreview);
  elements.messageTimeFormat.addEventListener('change', renderLivePreview);
  elements.messageDisplayName.addEventListener('input', () => { displayNameTouched = true; });
  elements.messageConfigId.addEventListener('input', () => {
    idTouched = true;
    const normalized = partialSlug(elements.messageConfigId.value);
    if (elements.messageConfigId.value !== normalized) elements.messageConfigId.value = normalized;
  });
  elements.messageConfigId.addEventListener('blur', () => { elements.messageConfigId.value = slug(elements.messageConfigId.value); });
  elements.messageForm.addEventListener('submit', saveMessage);
  elements.archiveMessageButton.addEventListener('click', archiveSelectedMessage);
  elements.deleteMessageButton.addEventListener('click', deleteSelectedMessage);
  elements.refreshMessagesButton.addEventListener('click', (event) => { event.preventDefault(); loadMessageConfig(); });
  elements.userFieldPrinter.addEventListener('change', () => { resetUserFieldForm(); renderPrinterUserFields(); });
  elements.newPrinterUserField.addEventListener('click', () => {
    resetUserFieldForm();
    elements.printerUserFieldForm.classList.remove('hidden');
    elements.printerUserFieldLabel.focus();
  });
  elements.printerUserFieldLabel.addEventListener('input', () => {
    if (!userFieldNameTouched) elements.printerUserFieldName.value = printerFieldName(elements.printerUserFieldLabel.value);
  });
  elements.printerUserFieldName.addEventListener('input', () => {
    userFieldNameTouched = true;
    const normalized = printerFieldName(elements.printerUserFieldName.value);
    if (elements.printerUserFieldName.value !== normalized) elements.printerUserFieldName.value = normalized;
  });
  elements.cancelPrinterUserField.addEventListener('click', resetUserFieldForm);
  elements.printerUserFieldForm.addEventListener('submit', saveUserField);
  elements.printerUserFieldList.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-user-field]');
    const remove = event.target.closest('[data-delete-user-field]');
    if (edit) editUserField(userFields.find((field) => field.id === edit.dataset.editUserField));
    if (remove) deleteUserField(remove.dataset.deleteUserField);
  });
  window.clearInterval(livePreviewClock);
  livePreviewClock = window.setInterval(() => {
    if (document.hidden || elements.messageForm.classList.contains('hidden')) return;
    renderLivePreview();
  }, 1000);
}

export { loadMessageConfig, setupMessageConfig };

import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';

let messages = [];
let printers = [];
let selectedId = null;
let creating = false;
let idTouched = false;
let activeLine = null;

function selectedMessage() {
  return messages.find((message) => message.id === selectedId) || null;
}

function slug(value, fallback = '') {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || fallback;
}

function partialSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 50);
}

function fieldKey(value, fallback = 'field') {
  const key = slug(value, fallback).slice(0, 30);
  return /^[a-z]/.test(key) ? key : `field-${key}`.slice(0, 30);
}

function renderMessageList() {
  clear(elements.messageList);
  if (!messages.length) {
    elements.messageList.appendChild(el('p', { className: 'muted', text: 'No messages configured.' }));
    return;
  }
  for (const message of messages) {
    elements.messageList.appendChild(el('button', {
      type: 'button', className: message.id === selectedId ? 'message-list-item active' : 'message-list-item', dataset: { id: message.id }
    }, [el('strong', { text: message.displayName }), el('span', { text: message.enabled ? 'Enabled' : 'Disabled' })]));
  }
}

function assignmentFor(message, printerId) {
  return (message.printerAssignments || []).find((assignment) => assignment.printerId === printerId) || null;
}

function renderAssignments(message) {
  clear(elements.messageAssignments);
  for (const printer of printers) {
    const assignment = assignmentFor(message, printer.id);
    elements.messageAssignments.appendChild(el('div', { className: 'assignment-row' }, [
      el('label', { className: 'checkbox-line' }, [
        el('input', { type: 'checkbox', checked: assignment?.enabled ? 'checked' : null, dataset: { assignmentEnabled: printer.id } }),
        el('span', { text: printer.name })
      ]),
      el('label', {}, [
        el('span', { text: 'Stored printer message' }),
        el('input', { value: assignment?.printerMessageName || '', maxlength: '30', autocomplete: 'off', dataset: { assignmentName: printer.id } })
      ])
    ]));
  }
}

function fieldRows() {
  return [...elements.messageFieldRows.querySelectorAll('[data-message-field-row]')];
}

function collectFields({ strict = false } = {}) {
  const fields = fieldRows().map((row, index) => {
    const label = row.querySelector('[data-field-label]').value.trim();
    const key = row.dataset.fieldKey || fieldKey(label, `field-${index + 1}`);
    return {
      key,
      label,
      printerFieldName: row.querySelector('[data-field-printer-name]').value.trim().toUpperCase(),
      required: row.querySelector('[data-field-required]').checked,
      maxLength: Number(row.querySelector('[data-field-max-length]').value),
      transform: row.querySelector('[data-field-uppercase]').checked ? 'uppercase' : 'none'
    };
  });
  if (strict) {
    if (fields.some((field) => !field.label || !field.printerFieldName)) throw new Error('Every user field needs a name and printer field name.');
    if (fields.some((field) => !Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 50)) throw new Error('Field maximum length must be between 1 and 50.');
    if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error('User field names must be unique.');
    if (new Set(fields.map((field) => field.printerFieldName)).size !== fields.length) throw new Error('Printer field names must be unique.');
  }
  return fields;
}

function fieldRow(field = {}) {
  return el('article', { className: 'message-field-editor-row', dataset: { messageFieldRow: 'true', fieldKey: field.key || 'field' } }, [
    el('div', { className: 'message-field-editor-row-heading' }, [
      el('strong', { text: field.label || 'New user field' }),
      el('button', { className: 'ghost danger-text', type: 'button', text: 'Remove', dataset: { removeMessageField: 'true' } })
    ]),
    el('div', { className: 'message-field-editor-grid' }, [
      el('label', {}, [el('span', { text: 'Field name' }), el('input', { value: field.label || '', maxlength: '60', required: 'required', autocomplete: 'off', dataset: { fieldLabel: 'true' } })]),
      el('label', {}, [el('span', { text: 'Printer field name' }), el('input', { value: field.printerFieldName || '', maxlength: '30', required: 'required', autocomplete: 'off', dataset: { fieldPrinterName: 'true' } })]),
      el('label', {}, [el('span', { text: 'Maximum length' }), el('input', { type: 'number', value: String(field.maxLength || 30), min: '1', max: '50', required: 'required', dataset: { fieldMaxLength: 'true' } })]),
      el('label', { className: 'checkbox-line message-field-toggle' }, [el('input', { type: 'checkbox', checked: field.transform !== 'none' ? 'checked' : null, dataset: { fieldUppercase: 'true' } }), el('span', { text: 'Force uppercase' })]),
      el('label', { className: 'checkbox-line message-field-toggle' }, [el('input', { type: 'checkbox', checked: field.required !== false ? 'checked' : null, dataset: { fieldRequired: 'true' } }), el('span', { text: 'Required' })])
    ]),
    el('small', { className: 'message-field-token-name', text: `Print token: {{${field.key || 'field-name'}}}` })
  ]);
}

function renderFields(fields = []) {
  clear(elements.messageFieldRows);
  if (!fields.length) elements.messageFieldRows.appendChild(el('p', { className: 'no-message-fields', text: 'No user fields. Add one only when the stored printer message expects an operator or release value.' }));
  for (const field of fields) elements.messageFieldRows.appendChild(fieldRow(field));
  renderTokenPalette();
}

function lineValues() {
  return [...elements.messageLineBuilder.querySelectorAll('[data-message-line]')].map((input) => input.value);
}

function insertToken(input, token) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`;
  input.focus();
  input.setSelectionRange(start + token.length, start + token.length);
  activeLine = input;
  renderLivePreview();
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
}

function renderTokenPalette() {
  clear(elements.messageTokenPalette);
  const tokens = collectFields().filter((field) => field.label).map((field) => ({ key: field.key, label: field.label }));
  tokens.push({ key: 'bestBeforeDate', label: 'Best-before date' }, { key: 'currentTime', label: 'Production time' });
  for (const token of tokens) {
    const value = `{{${token.key}}}`;
    const button = el('button', { className: 'message-token', type: 'button', draggable: 'true', dataset: { messageToken: value }, text: token.label });
    button.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', value));
    elements.messageTokenPalette.appendChild(button);
  }
}

function addMonthsClamped(date, months) {
  const result = new Date(date.valueOf());
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  result.setDate(Math.min(day, new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()));
  return result;
}

function pad2(value) { return String(value).padStart(2, '0'); }

function sampleDate() {
  const date = addMonthsClamped(new Date(), Number(elements.messageDateMonths.value || 0));
  const format = elements.messageDateFormat.value;
  const values = { DD: pad2(date.getDate()), MM: pad2(date.getMonth() + 1), YYYY: String(date.getFullYear()), YY: String(date.getFullYear()).slice(-2) };
  return format.replace(/YYYY|YY|DD|MM/g, (token) => values[token]);
}

function sampleTime() {
  const date = new Date();
  if (elements.messageTimeFormat.value === 'HH:mm') return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (elements.messageTimeFormat.value === 'hh:mm A') return `${pad2(date.getHours() % 12 || 12)}:${pad2(date.getMinutes())} ${date.getHours() >= 12 ? 'PM' : 'AM'}`;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function renderLivePreview() {
  const values = Object.fromEntries(collectFields().map((field) => [field.key, `[${field.label || field.key}]`]));
  values.bestBeforeDate = sampleDate();
  values.currentTime = sampleTime();
  values.productionTime = values.currentTime;
  const rendered = lineValues().map((line) => line.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key) => values[key] ?? `[UNKNOWN: ${key}]`));
  elements.messageDefinitionPreview.textContent = rendered.some(Boolean) ? rendered.join('\n') : 'Build the expected print lines above.';
}

function populateForm(message) {
  selectedId = message.id;
  creating = false;
  idTouched = true;
  elements.messageForm.classList.remove('hidden');
  elements.messageConfigId.readOnly = true;
  elements.messageConfigId.value = message.id;
  elements.messageDisplayName.value = message.displayName;
  elements.messageEnabled.checked = message.enabled;
  elements.messageDateMonths.value = message.dateRule?.months ?? 12;
  elements.messageDateFormat.value = message.dateRule?.format || 'DD/MM/YYYY';
  elements.messageTimeFormat.value = message.timeRule?.format || 'HH:mm:ss';
  elements.messageLineCount.value = String(Math.min(Math.max(message.previewLines?.length || 2, 1), 4));
  renderFields(message.fields || []);
  renderLineBuilder(message.previewLines || []);
  renderAssignments(message);
  renderMessageList();
}

function startNewMessage() {
  creating = true;
  selectedId = null;
  idTouched = false;
  elements.messageForm.classList.remove('hidden');
  elements.messageConfigId.readOnly = false;
  elements.messageConfigId.value = '';
  elements.messageDisplayName.value = '';
  elements.messageEnabled.checked = true;
  elements.messageDateMonths.value = '0';
  elements.messageDateFormat.value = 'DD/MM/YYYY';
  elements.messageTimeFormat.value = 'HH:mm:ss';
  elements.messageLineCount.value = '2';
  renderFields([]);
  renderLineBuilder(['', '']);
  renderAssignments({ printerAssignments: [] });
  renderMessageList();
  elements.messageDisplayName.focus();
}

function collectAssignments() {
  return printers.map((printer) => ({
    printerId: printer.id,
    printerMessageName: elements.messageAssignments.querySelector(`[data-assignment-name="${printer.id}"]`)?.value.trim(),
    enabled: Boolean(elements.messageAssignments.querySelector(`[data-assignment-enabled="${printer.id}"]`)?.checked)
  })).filter((assignment) => assignment.enabled || assignment.printerMessageName);
}

async function saveMessage(event) {
  event.preventDefault();
  const message = selectedMessage();
  if (!message && !creating) return;
  elements.saveMessageButton.disabled = true;
  setNotice(elements.messageConfigMessage, 'Saving message...');
  try {
    const previewLines = lineValues().map((line) => line.trimEnd());
    if (previewLines.some((line) => !line.trim())) throw new Error('Every configured print line needs content. Reduce the line count or build the missing line.');
    const payload = {
      id: slug(elements.messageConfigId.value),
      displayName: elements.messageDisplayName.value.trim(),
      enabled: elements.messageEnabled.checked,
      fields: collectFields({ strict: true }),
      dateRule: { type: 'offset-months', months: Number(elements.messageDateMonths.value), format: elements.messageDateFormat.value },
      timeRule: { type: 'production-time', format: elements.messageTimeFormat.value },
      previewLines,
      printerAssignments: collectAssignments()
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

async function loadMessageConfig() {
  setNotice(elements.messageConfigMessage, 'Loading messages...');
  try {
    [messages, printers] = await Promise.all([apiJson('/api/messages'), apiJson('/api/printers')]);
    const next = selectedMessage() || messages[0] || null;
    renderMessageList();
    if (next) populateForm(next);
    else elements.messageForm.classList.add('hidden');
    setNotice(elements.messageConfigMessage);
  } catch (error) {
    setNotice(elements.messageConfigMessage, normalizeError(error), 'error');
  }
}

function setupMessageConfig() {
  elements.newMessageButton.addEventListener('click', startNewMessage);
  elements.messageList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-id]');
    const message = messages.find((item) => item.id === button?.dataset.id);
    if (message) populateForm(message);
  });
  elements.addMessageField.addEventListener('click', () => {
    if (elements.messageFieldRows.querySelector('.no-message-fields')) clear(elements.messageFieldRows);
    elements.messageFieldRows.appendChild(fieldRow({ key: `field-${fieldRows().length + 1}` }));
    renderTokenPalette();
  });
  elements.messageFieldRows.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-message-field]');
    if (!button) return;
    button.closest('[data-message-field-row]').remove();
    if (!fieldRows().length) renderFields([]);
    else { renderTokenPalette(); renderLivePreview(); }
  });
  elements.messageFieldRows.addEventListener('input', (event) => {
    if (event.target.matches('[data-field-printer-name]')) event.target.value = event.target.value.toUpperCase();
    const row = event.target.closest('[data-message-field-row]');
    if (row && event.target.matches('[data-field-label]')) {
      const oldKey = row.dataset.fieldKey;
      const newKey = fieldKey(event.target.value, oldKey);
      if (newKey !== oldKey) {
        for (const input of elements.messageLineBuilder.querySelectorAll('[data-message-line]')) {
          input.value = input.value.replaceAll(`{{${oldKey}}}`, `{{${newKey}}}`);
        }
        row.dataset.fieldKey = newKey;
      }
      row.querySelector('.message-field-editor-row-heading strong').textContent = event.target.value || 'New user field';
      row.querySelector('.message-field-token-name').textContent = `Print token: {{${row.dataset.fieldKey}}}`;
      renderTokenPalette();
    }
    renderLivePreview();
  });
  elements.messageTokenPalette.addEventListener('click', (event) => {
    const button = event.target.closest('[data-message-token]');
    if (button) insertToken(activeLine || elements.messageLineBuilder.querySelector('[data-message-line]'), button.dataset.messageToken);
  });
  elements.messageLineCount.addEventListener('change', () => renderLineBuilder());
  elements.messageLineBuilder.addEventListener('input', renderLivePreview);
  elements.messageDateMonths.addEventListener('input', renderLivePreview);
  elements.messageDateFormat.addEventListener('change', renderLivePreview);
  elements.messageTimeFormat.addEventListener('change', renderLivePreview);
  elements.messageDisplayName.addEventListener('input', () => {
    if (creating && !idTouched) elements.messageConfigId.value = slug(elements.messageDisplayName.value);
  });
  elements.messageConfigId.addEventListener('input', () => {
    idTouched = true;
    const normalized = partialSlug(elements.messageConfigId.value);
    if (elements.messageConfigId.value !== normalized) elements.messageConfigId.value = normalized;
  });
  elements.messageConfigId.addEventListener('blur', () => { elements.messageConfigId.value = slug(elements.messageConfigId.value); });
  elements.messageForm.addEventListener('submit', saveMessage);
  elements.refreshMessagesButton.addEventListener('click', (event) => { event.preventDefault(); loadMessageConfig(); });
}

export { loadMessageConfig, setupMessageConfig };

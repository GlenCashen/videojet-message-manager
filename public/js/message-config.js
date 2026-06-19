import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';

let messages = [];
let printers = [];
let selectedId = null;
let creating = false;

function selectedMessage() {
  return messages.find((message) => message.id === selectedId) || null;
}

function renderMessageList() {
  clear(elements.messageList);
  if (!messages.length) {
    elements.messageList.appendChild(el('p', { className: 'muted', text: 'No messages configured.' }));
    return;
  }

  for (const message of messages) {
    const button = el('button', {
      type: 'button',
      className: message.id === selectedId ? 'message-list-item active' : 'message-list-item',
      dataset: { id: message.id }
    }, [
      el('strong', { text: message.displayName }),
      el('span', { text: message.enabled ? 'Enabled' : 'Disabled' })
    ]);
    elements.messageList.appendChild(button);
  }
}

function assignmentFor(message, printerId) {
  return (message.printerAssignments || []).find((assignment) => assignment.printerId === printerId) || null;
}

function renderAssignments(message) {
  clear(elements.messageAssignments);
  for (const printer of printers) {
    const assignment = assignmentFor(message, printer.id);
    const enabled = Boolean(assignment?.enabled);
    const checkbox = el('input', {
      type: 'checkbox',
      checked: enabled ? 'checked' : null,
      dataset: { assignmentEnabled: printer.id }
    });
    const input = el('input', {
      value: assignment?.printerMessageName || '',
      maxlength: '30',
      autocomplete: 'off',
      dataset: { assignmentName: printer.id }
    });

    elements.messageAssignments.appendChild(el('div', { className: 'assignment-row' }, [
      el('label', { className: 'checkbox-line' }, [
        checkbox,
        el('span', { text: printer.name })
      ]),
      el('label', {}, [
        el('span', { text: 'Stored printer message' }),
        input
      ])
    ]));
  }
}

function populateForm(message) {
  selectedId = message.id;
  creating = false;
  elements.messageForm.classList.remove('hidden');
  elements.messageConfigId.readOnly = true;
  elements.messageConfigId.value = message.id;
  elements.messageDisplayName.value = message.displayName;
  elements.messageEnabled.checked = message.enabled;
  elements.messageDateMonths.value = message.dateRule?.months || 12;
  elements.messageFieldsJson.value = JSON.stringify(message.fields || [], null, 2);
  elements.messagePreviewLines.value = (message.previewLines || []).join('\n');
  renderAssignments(message);
  renderMessageList();
}

function startNewMessage() {
  creating = true;
  selectedId = null;
  elements.messageForm.classList.remove('hidden');
  elements.messageConfigId.readOnly = false;
  elements.messageConfigId.value = '';
  elements.messageDisplayName.value = '';
  elements.messageEnabled.checked = true;
  elements.messageDateMonths.value = '15';
  elements.messageFieldsJson.value = JSON.stringify([
    { key: 'run', label: 'Run number', printerFieldName: 'RUN', required: true, maxLength: 30, transform: 'uppercase' },
    { key: 'batch', label: 'Batch code', printerFieldName: 'BATCH', required: true, maxLength: 30, transform: 'uppercase' }
  ], null, 2);
  elements.messagePreviewLines.value = '{{run}}{{batch}}\nBBD: {{bestBeforeDate}} {{currentTime}}';
  renderAssignments({ printerAssignments: [] });
  renderMessageList();
  elements.messageConfigId.focus();
}

function collectAssignments() {
  return printers
    .map((printer) => {
      const enabled = elements.messageAssignments.querySelector(`[data-assignment-enabled="${printer.id}"]`)?.checked;
      const printerMessageName = elements.messageAssignments.querySelector(`[data-assignment-name="${printer.id}"]`)?.value.trim();
      return {
        printerId: printer.id,
        printerMessageName,
        enabled: Boolean(enabled)
      };
    })
    .filter((assignment) => assignment.enabled || assignment.printerMessageName);
}

async function saveMessage(event) {
  event.preventDefault();
  const message = selectedMessage();
  if (!message && !creating) return;

  elements.saveMessageButton.disabled = true;
  setNotice(elements.messageConfigMessage, 'Saving message...');
  try {
    const fields = JSON.parse(elements.messageFieldsJson.value || '[]');
    const previewLines = elements.messagePreviewLines.value
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    const id = elements.messageConfigId.value.trim().toLowerCase();
    const payload = {
      id,
        displayName: elements.messageDisplayName.value.trim(),
        enabled: elements.messageEnabled.checked,
        fields,
        dateRule: { type: 'offset-months', months: Number(elements.messageDateMonths.value) },
        previewLines,
        printerAssignments: collectAssignments()
    };
    const data = await apiJson(creating ? '/api/messages' : `/api/messages/${encodeURIComponent(message.id)}`, {
      method: creating ? 'POST' : 'PUT',
      body: payload
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
    [messages, printers] = await Promise.all([
      apiJson('/api/messages'),
      apiJson('/api/printers')
    ]);
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
    if (!button) return;
    const message = messages.find((item) => item.id === button.dataset.id);
    if (message) populateForm(message);
  });
  elements.messageForm.addEventListener('submit', saveMessage);
  elements.refreshMessagesButton.addEventListener('click', (event) => {
    event.preventDefault();
    loadMessageConfig();
  });
}

export { loadMessageConfig, setupMessageConfig };

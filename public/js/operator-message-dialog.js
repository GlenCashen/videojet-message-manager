import { apiJson, postJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { messageExpectedOutput } from './release-preview.js';

const PREVIEW_DEBOUNCE_MS = 250;

function createOperatorMessageDialog({ elements, getStatus, onStatus }) {
  let printer = null;
  let messages = [];
  let latestPreview = null;
  let previewTimer = null;
  let previewRequestId = 0;
  let busy = false;

  function selectedMessage() {
    return messages.find((message) => message.id === elements.messageName.value) || null;
  }

  function fieldInputs() {
    return [...elements.fields.querySelectorAll('input[data-field-key]')];
  }

  function fieldValues() {
    return Object.fromEntries(fieldInputs().map((input) => [input.dataset.fieldKey, input.value.trim()]));
  }

  function validate() {
    const message = selectedMessage();
    const fields = fieldValues();
    const errors = {};
    if (!message) return { valid: false, fields, errors: { message: 'Select a message.' } };
    for (const field of message.fields) {
      const value = fields[field.key] || '';
      if (field.required && !value) errors[field.key] = `${field.label} is required.`;
      else if (value.length > field.maxLength) errors[field.key] = `${field.label} must be ${field.maxLength} characters or fewer.`;
    }
    return { valid: Object.keys(errors).length === 0, fields, errors };
  }

  function setErrors(errors = {}) {
    for (const node of elements.fields.querySelectorAll('[data-field-error]')) {
      node.textContent = errors[node.dataset.fieldError] || '';
    }
  }

  function setBusy(value) {
    busy = value;
    elements.close.disabled = value;
    elements.cancel.disabled = value;
    elements.messageName.disabled = value;
    elements.review.disabled = value || !messages.length;
    elements.confirm.disabled = value || !messages.length;
    for (const input of fieldInputs()) input.disabled = value;
  }

  function resetReview() {
    elements.reviewSummary.classList.add('hidden');
    clear(elements.reviewSummary);
    elements.review.classList.remove('hidden');
    elements.confirm.classList.add('hidden');
  }

  function renderFields() {
    clear(elements.fields);
    latestPreview = null;
    resetReview();
    const message = selectedMessage();
    if (!message) {
      elements.fields.textContent = 'No messages are assigned to this printer.';
      elements.preview.textContent = 'No preview available.';
      return;
    }

    for (const field of message.fields) {
      const input = el('input', {
        id: `dashboard-field-${field.key}`,
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
        resetReview();
        schedulePreview();
      });
      elements.fields.appendChild(el('label', { for: input.id }, [
        el('span', { text: field.required ? `${field.label} *` : field.label }),
        input,
        el('small', { className: 'field-error', dataset: { fieldError: field.key } })
      ]));
    }
    schedulePreview();
  }

  function renderMessageOptions() {
    clear(elements.messageName);
    for (const message of messages) {
      elements.messageName.appendChild(el('option', { value: message.id, text: message.displayName }));
    }
    renderFields();
  }

  async function refreshPreview() {
    const message = selectedMessage();
    const validation = validate();
    setErrors(validation.errors);
    if (!message || !validation.valid) {
      latestPreview = null;
      elements.preview.textContent = 'Complete all required fields to generate the exact preview.';
      return null;
    }

    const requestId = ++previewRequestId;
    elements.preview.textContent = 'Generating preview...';
    try {
      const preview = await postJson(`/api/messages/${encodeURIComponent(message.id)}/preview`, {
        printerId: printer.id,
        fields: validation.fields
      });
      if (requestId !== previewRequestId) return latestPreview;
      latestPreview = preview;
      elements.preview.textContent = preview.rendered;
      return preview;
    } catch (error) {
      if (requestId === previewRequestId) {
        latestPreview = null;
        elements.preview.textContent = normalizeError(error);
      }
      return null;
    }
  }

  function schedulePreview() {
    window.clearTimeout(previewTimer);
    const validation = validate();
    setErrors(validation.errors);
    if (!validation.valid) {
      latestPreview = null;
      elements.preview.textContent = 'Complete all required fields to generate the exact preview.';
      return;
    }
    elements.preview.textContent = 'Preview will update shortly...';
    previewTimer = window.setTimeout(refreshPreview, PREVIEW_DEBOUNCE_MS);
  }

  function refreshLivePreviewTime() {
    if (!elements.dialog.open || document.hidden || !latestPreview) return;
    const message = selectedMessage();
    const validation = validate();
    if (!message || !validation.valid) return;
    latestPreview = { ...latestPreview, ...messageExpectedOutput(message, validation.fields) };
    elements.preview.textContent = latestPreview.rendered;
  }

  function addSummaryLine(label, value) {
    elements.reviewSummary.appendChild(el('div', { className: 'review-line' }, [
      el('span', { text: label }),
      el('strong', { text: value })
    ]));
  }

  async function review(event) {
    event.preventDefault();
    if (busy) return;
    const preview = await refreshPreview();
    const message = selectedMessage();
    if (!preview || !message) {
      setNotice(elements.notice, 'Complete all required fields before reviewing this message.', 'error');
      return;
    }
    clear(elements.reviewSummary);
    addSummaryLine('Printer', printer.name);
    addSummaryLine('Message', message.displayName);
    for (const field of message.fields) addSummaryLine(field.label, fieldValues()[field.key] || '-');
    elements.reviewSummary.classList.remove('hidden');
    elements.review.classList.add('hidden');
    elements.confirm.classList.remove('hidden');
    setNotice(elements.notice, 'Check the printer, message, fields, and expected print before confirming.');
  }

  function successMessage(result) {
    if (result.verificationAvailable === false) {
      return `Message change acknowledged by Videojet ${printer.model || '1710'}. Current-message readback is unavailable; a physical print check is required.`;
    }
    return `Message updated and verified. The printer reports ${result.selectedMessage || result.requestedMessage}. A physical print check is still required.`;
  }

  async function confirm() {
    if (busy) return;
    const message = selectedMessage();
    const validation = validate();
    if (!message || !validation.valid || !latestPreview) return;

    setBusy(true);
    setNotice(elements.notice, 'Sending the queued message change...');
    try {
      const status = getStatus(printer.id) || {};
      const result = await postJson(`/api/printers/${encodeURIComponent(printer.id)}/set`, {
        messageId: message.id,
        fields: validation.fields,
        expectedRevision: status.revision
      });
      onStatus(result);

      if (result.verificationAvailable !== false && printer.capabilities?.currentMessageReadback !== false) {
        try {
          const readback = await apiJson(`/api/printer/current-message?printerId=${encodeURIComponent(printer.id)}`);
          onStatus({ printerId: printer.id, selectedMessage: readback.currentMessage, checkedAt: readback.checkedAt });
          if (readback.currentMessage !== result.requestedMessage) {
            setNotice(elements.notice, `MESSAGE MISMATCH: requested ${result.requestedMessage}, but the printer reports ${readback.currentMessage}. Do not start production.`, 'error');
            return;
          }
        } catch (error) {
          setNotice(elements.notice, `Message change sent, but readback failed: ${normalizeError(error)}`, 'error');
          return;
        }
      }

      setNotice(elements.notice, successMessage(result), 'success');
      elements.confirm.classList.add('hidden');
      elements.cancel.textContent = 'Done';
    } catch (error) {
      if (error.data) onStatus(error.data);
      setNotice(elements.notice, normalizeError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    window.clearTimeout(previewTimer);
    elements.dialog.close();
    printer = null;
    messages = [];
  }

  async function open(nextPrinter) {
    printer = nextPrinter;
    messages = [];
    elements.title.textContent = `Set message on ${printer.name}`;
    const modelLabel = (printer.protocol || 'wsi') === 'ngpcl' ? 'Markem NGPCL' : `Videojet ${printer.model || '1620'}`;
    elements.subtitle.textContent = `${printer.location || 'No location'} | ${modelLabel} | ${printer.host}:${printer.port}`;
    elements.cancel.textContent = 'Cancel';
    setNotice(elements.notice, 'Loading assigned messages...');
    clear(elements.fields);
    clear(elements.messageName);
    resetReview();
    elements.preview.textContent = 'Loading...';
    elements.dialog.showModal();
    setBusy(true);
    try {
      messages = await apiJson(`/api/printers/${encodeURIComponent(printer.id)}/messages`);
      renderMessageOptions();
      setNotice(elements.notice);
    } catch (error) {
      setNotice(elements.notice, normalizeError(error), 'error');
      elements.preview.textContent = 'Message options could not be loaded.';
    } finally {
      setBusy(false);
    }
  }

  elements.form.addEventListener('submit', review);
  elements.messageName.addEventListener('change', renderFields);
  elements.confirm.addEventListener('click', confirm);
  elements.cancel.addEventListener('click', close);
  elements.close.addEventListener('click', close);
  elements.dialog.addEventListener('click', (event) => {
    if (event.target === elements.dialog) close();
  });
  elements.dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  window.setInterval(refreshLivePreviewTime, 1000);

  return { open };
}

export { createOperatorMessageDialog };

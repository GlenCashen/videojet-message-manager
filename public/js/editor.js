import { apiJson } from './api.js';
import { normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';
import { state } from './state.js';

let editorCallbacks = {
  loadPrinters: async () => {}
};

function startEdit(id) {
  const coder = state.coders[id];
  if (!coder) return;
  const printer = coder.config;
  state.editingId = id;
  elements.printerId.value = id;
  elements.printerName.value = printer.name;
  elements.printerLocation.value = printer.location || '';
  elements.printerHost.value = printer.host;
  elements.printerPort.value = printer.port;
  elements.printerMode.value = printer.mode;
  elements.printerEnabled.checked = printer.enabled;
  elements.editorSubtitle.textContent = `Editing ${printer.name}`;
  setNotice(elements.editorMessage);
  elements.editorPanel.classList.remove('hidden');
  elements.printerName.focus();
}

function closeEditor() {
  state.editingId = null;
  elements.printerForm.reset();
  setNotice(elements.editorMessage);
  elements.editorPanel.classList.add('hidden');
}

async function savePrinter(event) {
  event.preventDefault();
  const id = elements.printerId.value;
  if (!id || !state.coders[id]) return;

  elements.savePrinterButton.disabled = true;
  setNotice(elements.editorMessage, 'Saving coder...');
  try {
    const data = await apiJson(`/api/printers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        name: elements.printerName.value.trim(),
        location: elements.printerLocation.value.trim(),
        host: elements.printerHost.value.trim(),
        port: Number(elements.printerPort.value),
        enabled: elements.printerEnabled.checked,
        mode: elements.printerMode.value
      }
    });

    if (!data || data.ok !== true || !data.printer) throw new Error('Save response did not include the updated coder.');
    await editorCallbacks.loadPrinters();
    startEdit(id);
    setNotice(elements.editorMessage, `${data.printer.name} saved.`, 'success');
  } catch (error) {
    setNotice(elements.editorMessage, normalizeError(error), 'error');
  } finally {
    elements.savePrinterButton.disabled = false;
  }
}

function setupEditor(callbacks) {
  editorCallbacks = { ...editorCallbacks, ...callbacks };
  elements.printerForm.addEventListener('submit', savePrinter);
  elements.cancelEditButton.addEventListener('click', closeEditor);
}

export { setupEditor, startEdit };

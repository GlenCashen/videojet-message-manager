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
  elements.printerId.disabled = true;
  elements.printerName.value = printer.name;
  elements.printerLocation.value = printer.location || '';
  elements.printerHost.value = printer.host;
  elements.printerPort.value = printer.port;
  elements.printerMode.value = printer.mode;
  elements.printerModel.value = printer.model || '1620';
  elements.printerReadbackMode.value = printer.readbackMode || 'auto';
  elements.printerEnabled.checked = printer.enabled;
  elements.deletePrinterButton.classList.remove('hidden');
  elements.editorSubtitle.textContent = `Editing ${printer.name}`;
  setNotice(elements.editorMessage);
  elements.editorPanel.classList.remove('hidden');
  elements.printerName.focus();
}

function startNew() {
  state.editingId = null;
  elements.printerForm.reset();
  elements.printerId.disabled = false;
  elements.printerMode.value = 'real';
  elements.printerModel.value = '1620';
  elements.printerReadbackMode.value = 'auto';
  elements.printerPort.value = '3100';
  elements.printerEnabled.checked = true;
  elements.deletePrinterButton.classList.add('hidden');
  elements.editorSubtitle.textContent = 'Add a new printer connection.';
  setNotice(elements.editorMessage);
  elements.editorPanel.classList.remove('hidden');
  elements.printerId.focus();
}

function closeEditor() {
  state.editingId = null;
  elements.printerForm.reset();
  elements.printerId.disabled = false;
  elements.deletePrinterButton.classList.add('hidden');
  setNotice(elements.editorMessage);
  elements.editorPanel.classList.add('hidden');
}

async function savePrinter(event) {
  event.preventDefault();
  const id = elements.printerId.value;
  const existing = Boolean(state.editingId);
  if (!id) return;

  elements.savePrinterButton.disabled = true;
  setNotice(elements.editorMessage, 'Saving coder...');
  try {
    const data = await apiJson(existing ? `/api/printers/${encodeURIComponent(id)}` : '/api/printers', {
      method: existing ? 'PUT' : 'POST',
      body: {
        id,
        name: elements.printerName.value.trim(),
        location: elements.printerLocation.value.trim(),
        host: elements.printerHost.value.trim(),
        port: Number(elements.printerPort.value),
        enabled: elements.printerEnabled.checked,
        mode: elements.printerMode.value,
        model: elements.printerModel.value,
        readbackMode: elements.printerReadbackMode.value
      }
    });

    if (!data || data.ok !== true || !data.printer) throw new Error('Save response did not include the updated coder.');
    await editorCallbacks.loadPrinters();
    startEdit(data.printer.id);
    setNotice(elements.editorMessage, `${data.printer.name} saved.`, 'success');
  } catch (error) {
    setNotice(elements.editorMessage, normalizeError(error), 'error');
  } finally {
    elements.savePrinterButton.disabled = false;
  }
}

async function removePrinter() {
  const id = elements.printerId.value;
  const printer = state.coders[id]?.config;
  if (!printer || !window.confirm(`Delete ${printer.name}? Historical audit and fault records will be retained.`)) return;
  elements.deletePrinterButton.disabled = true;
  setNotice(elements.editorMessage, `Deleting ${printer.name}...`);
  try {
    await apiJson(`/api/printers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closeEditor();
    await editorCallbacks.loadPrinters();
    setNotice(elements.dashboardMessage, `${printer.name} deleted. Historical records were retained.`, 'success');
  } catch (error) {
    setNotice(elements.editorMessage, normalizeError(error), 'error');
  } finally {
    elements.deletePrinterButton.disabled = false;
  }
}

function setupEditor(callbacks) {
  editorCallbacks = { ...editorCallbacks, ...callbacks };
  elements.printerForm.addEventListener('submit', savePrinter);
  elements.cancelEditButton.addEventListener('click', closeEditor);
  elements.newPrinterButton.addEventListener('click', startNew);
  elements.deletePrinterButton.addEventListener('click', removePrinter);
}

export { setupEditor, startEdit, startNew };

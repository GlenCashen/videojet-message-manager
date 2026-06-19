import { apiJson, postJson } from './api.js';
import { normalizeError } from './dom.js';
import { elements } from './elements.js';
import { state } from './state.js';

let toolsCallbacks = {
  loadLogs: async () => {}
};

function singlePrinterPayload() {
  return {
    printerId: elements.devPrinterId.value,
    ip: elements.ip.value.trim(),
    port: Number(elements.port.value),
    messageName: elements.messageName.value,
    fieldName: elements.fieldName.value.trim(),
    fieldValue: elements.fieldValue.value
  };
}

function setSinglePrinterBusy(busy) {
  elements.checkButton.disabled = busy;
  elements.setButton.disabled = busy;
}

function showSinglePrinterError(message = '') {
  elements.errorBox.textContent = message;
  elements.errorBox.classList.toggle('hidden', !message);
}

async function checkSinglePrinter() {
  setSinglePrinterBusy(true);
  showSinglePrinterError('');
  elements.lastResult.textContent = 'Checking...';
  try {
    const data = await postJson('/api/check', singlePrinterPayload());
    elements.selectedMessage.textContent = data.selectedMessage || '-';
    elements.printerStatus.textContent = data.status || '-';
    elements.lastResult.textContent = 'Printer reachable';
    await Promise.all([toolsCallbacks.loadLogs(), elements.useEmulator.checked ? loadEmulator() : Promise.resolve()]);
  } catch (error) {
    elements.lastResult.textContent = 'Check failed';
    showSinglePrinterError(normalizeError(error));
    await toolsCallbacks.loadLogs();
  } finally {
    setSinglePrinterBusy(false);
  }
}

async function setSinglePrinter() {
  const body = singlePrinterPayload();
  elements.expectedMessage.textContent = body.messageName;
  setSinglePrinterBusy(true);
  showSinglePrinterError('');
  elements.lastResult.textContent = 'Updating...';
  try {
    const data = await postJson('/api/set', body);
    elements.selectedMessage.textContent = data.selectedMessage || '-';
    elements.printerStatus.textContent = data.status || '-';
    elements.lastResult.textContent = data.messageMatches ? 'Set and verified' : 'Message mismatch';
    await Promise.all([toolsCallbacks.loadLogs(), elements.useEmulator.checked ? loadEmulator() : Promise.resolve()]);
  } catch (error) {
    elements.lastResult.textContent = 'Set failed';
    showSinglePrinterError(normalizeError(error));
    await toolsCallbacks.loadLogs();
  } finally {
    setSinglePrinterBusy(false);
  }
}

async function loadEmulator() {
  const emulator = await apiJson('/api/emulator');
  applyEmulatorState(emulator);
}

function applyEmulatorState(emulator) {
  elements.emulatorMessage.value = emulator.selectedMessage;
  elements.emulatorStatus.value = emulator.status;
  elements.emulatorAlarm.value = emulator.alarm || 'none';
  const activeFaults = new Set(emulator.activeFaultCodes || []);
  elements.emulatorFaults.replaceChildren(...(emulator.availableFaults || []).map((fault) => {
    const label = document.createElement('label');
    label.className = 'checkbox-line fault-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.faultCode = fault.code;
    input.checked = activeFaults.has(fault.code);
    label.append(input, document.createTextNode(fault.label));
    return label;
  }));
  elements.emulatorDelay.value = emulator.responseDelayMs;
  elements.emulatorEnabled.checked = emulator.enabled;
  elements.failNextCommand.checked = emulator.failNextCommand;
  elements.emulatorFields.textContent = JSON.stringify(emulator.userFields || {}, null, 2);
}

async function saveEmulator() {
  showSinglePrinterError('');
  try {
    await postJson('/api/emulator', {
      selectedMessage: elements.emulatorMessage.value,
      faultCodes: [...elements.emulatorFaults.querySelectorAll('input[data-fault-code]:checked')]
        .map((input) => input.dataset.faultCode),
      alarm: elements.emulatorAlarm.value,
      responseDelayMs: Number(elements.emulatorDelay.value),
      enabled: elements.emulatorEnabled.checked,
      failNextCommand: elements.failNextCommand.checked
    });
    await loadEmulator();
  } catch (error) {
    showSinglePrinterError(normalizeError(error));
  }
}

async function resetEmulator() {
  showSinglePrinterError('');
  try {
    await postJson('/api/emulator/reset', {});
    await loadEmulator();
  } catch (error) {
    showSinglePrinterError(normalizeError(error));
  }
}

function setMode(useEmulator) {
  if (useEmulator) {
    state.realPrinter = { ip: elements.ip.value.trim(), port: Number(elements.port.value) || 3100 };
    elements.ip.value = state.config.emulatorIp;
    elements.port.value = state.config.emulatorPort;
    elements.ip.disabled = true;
    elements.port.disabled = true;
    elements.emulatorPanel.classList.remove('hidden');
    elements.modeHelp.textContent = `Local emulator at ${state.config.emulatorIp}:${state.config.emulatorPort}`;
    loadEmulator().catch((error) => showSinglePrinterError(normalizeError(error)));
  } else {
    elements.ip.disabled = false;
    elements.port.disabled = false;
    elements.ip.value = state.realPrinter.ip;
    elements.port.value = state.realPrinter.port;
    elements.emulatorPanel.classList.add('hidden');
    elements.modeHelp.textContent = 'Real printer mode';
  }
}

async function loadConfig() {
  try {
    state.config = await apiJson('/api/config');
    elements.ip.value = state.config.printerIp;
    elements.port.value = state.config.printerPort;
    state.realPrinter = { ip: state.config.printerIp, port: state.config.printerPort };
    await loadDevPrinterOptions();
  } catch (error) {
    showSinglePrinterError(normalizeError(error));
  }
}

async function loadDevPrinterOptions() {
  const printers = await apiJson('/api/printers');
  while (elements.devPrinterId.firstChild) elements.devPrinterId.removeChild(elements.devPrinterId.firstChild);
  for (const printer of printers) {
    const option = document.createElement('option');
    option.value = printer.id;
    option.textContent = `${printer.name} (${printer.id})`;
    elements.devPrinterId.appendChild(option);
  }
}

function setupSinglePrinterTools(callbacks) {
  toolsCallbacks = { ...toolsCallbacks, ...callbacks };
  elements.checkButton.addEventListener('click', checkSinglePrinter);
  elements.setButton.addEventListener('click', setSinglePrinter);
  elements.useEmulator.addEventListener('change', () => setMode(elements.useEmulator.checked));
  elements.saveEmulator.addEventListener('click', saveEmulator);
  elements.resetEmulator.addEventListener('click', resetEmulator);
}

export { applyEmulatorState, loadConfig, setupSinglePrinterTools };

const MODEL_CAPABILITIES = {
  '1620': {
    currentMessageReadback: true,
    commandErrorResponse: true
  },
  '1710': {
    currentMessageReadback: null,
    commandErrorResponse: false
  }
};

function normalizeReadbackMode(mode) {
  const value = String(mode || 'auto').trim().toLowerCase();
  if (!['auto', 'enabled', 'disabled'].includes(value)) {
    throw new Error('Current-message readback mode must be auto, enabled or disabled.');
  }
  return value;
}

function normalizePrinterModel(model) {
  const value = String(model || '1620').trim();
  if (!(value in MODEL_CAPABILITIES)) throw new Error('Printer model must be 1620 or 1710.');
  return value;
}

function printerCapabilities(model, readbackMode = 'auto') {
  const normalized = normalizePrinterModel(model);
  const mode = normalizeReadbackMode(readbackMode);
  const configured = mode === 'enabled' ? true : mode === 'disabled' ? false : MODEL_CAPABILITIES[normalized].currentMessageReadback;
  return {
    ...MODEL_CAPABILITIES[normalized],
    currentMessageReadback: configured,
    currentMessageReadbackMode: mode,
    currentMessageReadbackDetection: mode === 'auto' && configured === null ? 'unknown' : 'configured'
  };
}

export { MODEL_CAPABILITIES, normalizePrinterModel, normalizeReadbackMode, printerCapabilities };

const MODEL_CAPABILITIES = {
  '1620': {
    currentMessageReadback: true,
    commandErrorResponse: true
  },
  '1710': {
    currentMessageReadback: false,
    commandErrorResponse: false
  }
};

function normalizePrinterModel(model) {
  const value = String(model || '1620').trim();
  if (!(value in MODEL_CAPABILITIES)) throw new Error('Printer model must be 1620 or 1710.');
  return value;
}

function printerCapabilities(model) {
  const normalized = normalizePrinterModel(model);
  return { ...MODEL_CAPABILITIES[normalized] };
}

export { MODEL_CAPABILITIES, normalizePrinterModel, printerCapabilities };

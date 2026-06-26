import { formatDateTime, printerName, printerUrl, valueOrDash } from './common.js';

function printerFaultEmail(payload, config = {}) {
  const name = printerName(payload);
  const url = printerUrl(config.baseUrl, payload);
  const faults = Array.isArray(payload.faults) && payload.faults.length
    ? payload.faults.join(', ')
    : valueOrDash(payload.faultSummary);
  return {
    subject: `Printer fault: ${name}`,
    text: [
      'A printer fault or alarm is active.',
      '',
      `Printer: ${name}`,
      `Status: ${valueOrDash(payload.status)}`,
      `Faults: ${faults}`,
      `Detected at: ${formatDateTime(payload.detectedAt)}`,
      `Printer page: ${url}`,
      '',
      'Check the active fault details and follow the site escalation process.'
    ].join('\n')
  };
}

export { printerFaultEmail };

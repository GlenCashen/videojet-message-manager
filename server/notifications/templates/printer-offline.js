import { formatDateTime, printerName, printerUrl, valueOrDash } from './common.js';

function printerOfflineEmail(payload, config = {}) {
  const name = printerName(payload);
  const url = printerUrl(config.baseUrl, payload);
  return {
    subject: `Printer offline: ${name}`,
    text: [
      'A printer is offline or not responding to status polling.',
      '',
      `Printer: ${name}`,
      `Last successful update: ${formatDateTime(payload.lastSuccessfulAt)}`,
      `Latest attempt: ${formatDateTime(payload.latestAttemptAt || payload.detectedAt)}`,
      `Connection detail: ${valueOrDash(payload.errorMessage)}`,
      `Printer page: ${url}`,
      '',
      'Check the coder network connection, power state and printer-agent connectivity.'
    ].join('\n')
  };
}

export { printerOfflineEmail };

import { formatDateTime, printerName, printerUrl, valueOrDash } from './common.js';

function printerMessageMismatchEmail(payload, config = {}) {
  const name = printerName(payload);
  const url = printerUrl(config.baseUrl, payload);
  return {
    subject: `Message mismatch: ${name}`,
    text: [
      'MESSAGE MISMATCH - STOP PRODUCTION.',
      '',
      `Printer: ${name}`,
      `Expected message: ${valueOrDash(payload.expectedMessage)}`,
      `Current printer message: ${valueOrDash(payload.currentMessage)}`,
      `Detected at: ${formatDateTime(payload.detectedAt)}`,
      `Printer page: ${url}`,
      '',
      'Stop the line, quarantine product since the mismatch was detected, then resend the release and reverify the first print.'
    ].join('\n')
  };
}

export { printerMessageMismatchEmail };

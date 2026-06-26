import { escapeHtml, formatDateTime, printerName, printerUrl, valueOrDash } from './common.js';

function printerMessageMismatchEmail(payload, config = {}) {
  const name = printerName(payload);
  const url = printerUrl(config.baseUrl, payload);
  const detectedAt = formatDateTime(payload.detectedAt);
  const subject = `Message mismatch: ${name}`;
  return {
    subject,
    text: [
      'MESSAGE MISMATCH - STOP PRODUCTION.',
      '',
      `Printer: ${name}`,
      `Expected message: ${valueOrDash(payload.expectedMessage)}`,
      `Current printer message: ${valueOrDash(payload.currentMessage)}`,
      `Detected at: ${detectedAt}`,
      `Printer page: ${url}`,
      '',
      'Stop the line, quarantine product since the mismatch was detected, then resend the release and reverify the first print.'
    ].join('\n'),
    html: `
      <p><strong>MESSAGE MISMATCH - STOP PRODUCTION.</strong></p>

      <table cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
        <tr>
          <td><strong>Printer:</strong></td>
          <td>${escapeHtml(name)}</td>
        </tr>
        <tr>
          <td><strong>Expected message:</strong></td>
          <td>${escapeHtml(valueOrDash(payload.expectedMessage))}</td>
        </tr>
        <tr>
          <td><strong>Current printer message:</strong></td>
          <td>${escapeHtml(valueOrDash(payload.currentMessage))}</td>
        </tr>
        <tr>
          <td><strong>Detected at:</strong></td>
          <td>${escapeHtml(detectedAt)}</td>
        </tr>
        <tr>
          <td><strong>Printer page:</strong></td>
          <td><a href="${escapeHtml(url)}">Open printer</a></td>
        </tr>
      </table>

      <p>
        Stop the line, quarantine product since the mismatch was detected, then
        resend the release and reverify the first print.
      </p>
    `
  };
}

export { printerMessageMismatchEmail };

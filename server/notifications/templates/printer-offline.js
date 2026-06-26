import { escapeHtml, formatDateTime, printerName, printerUrl, valueOrDash } from './common.js';

function printerOfflineEmail(payload, config = {}) {
  const name = printerName(payload);
  const url = printerUrl(config.baseUrl, payload);
  const lastSuccessfulAt = formatDateTime(payload.lastSuccessfulAt);
  const latestAttemptAt = formatDateTime(payload.latestAttemptAt || payload.detectedAt);
  const subject = `Printer offline: ${name}`;
  return {
    subject,
    text: [
      'A printer is offline or not responding to status polling.',
      '',
      `Printer: ${name}`,
      `Last successful update: ${lastSuccessfulAt}`,
      `Latest attempt: ${latestAttemptAt}`,
      `Connection detail: ${valueOrDash(payload.errorMessage)}`,
      `Printer page: ${url}`,
      '',
      'Check the coder network connection, power state and printer-agent connectivity.'
    ].join('\n'),
    html: `
      <p>A printer is offline or not responding to status polling.</p>

      <table cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
        <tr>
          <td><strong>Printer:</strong></td>
          <td>${escapeHtml(name)}</td>
        </tr>
        <tr>
          <td><strong>Last successful update:</strong></td>
          <td>${escapeHtml(lastSuccessfulAt)}</td>
        </tr>
        <tr>
          <td><strong>Latest attempt:</strong></td>
          <td>${escapeHtml(latestAttemptAt)}</td>
        </tr>
        <tr>
          <td><strong>Connection detail:</strong></td>
          <td>${escapeHtml(valueOrDash(payload.errorMessage))}</td>
        </tr>
        <tr>
          <td><strong>Printer page:</strong></td>
          <td><a href="${escapeHtml(url)}">Open printer</a></td>
        </tr>
      </table>

      <p>
        Check the coder network connection, power state and printer-agent
        connectivity.
      </p>
    `
  };
}

export { printerOfflineEmail };

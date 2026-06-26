import { escapeHtml, formatDateTime, printerName, printerUrl, valueOrDash } from './common.js';

function printerFaultEmail(payload, config = {}) {
  const name = printerName(payload);
  const url = printerUrl(config.baseUrl, payload);
  const faults = Array.isArray(payload.faults) && payload.faults.length
    ? payload.faults.join(', ')
    : valueOrDash(payload.faultSummary);
  const detectedAt = formatDateTime(payload.detectedAt);
  const subject = `Printer fault: ${name}`;
  return {
    subject,
    text: [
      'A printer fault or alarm is active.',
      '',
      `Printer: ${name}`,
      `Status: ${valueOrDash(payload.status)}`,
      `Faults: ${faults}`,
      `Detected at: ${detectedAt}`,
      `Printer page: ${url}`,
      '',
      'Check the active fault details and follow the site escalation process.'
    ].join('\n'),
    html: `
      <p>A printer fault or alarm is active.</p>

      <table cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
        <tr>
          <td><strong>Printer:</strong></td>
          <td>${escapeHtml(name)}</td>
        </tr>
        <tr>
          <td><strong>Status:</strong></td>
          <td>${escapeHtml(valueOrDash(payload.status))}</td>
        </tr>
        <tr>
          <td><strong>Faults:</strong></td>
          <td>${escapeHtml(faults)}</td>
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
        Check the active fault details and follow the site escalation process.
      </p>
    `
  };
}

export { printerFaultEmail };

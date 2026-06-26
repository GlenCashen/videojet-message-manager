import { formatDateTime, notificationHtml, printerName, printerUrl, valueOrDash } from './common.js';

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
    html: notificationHtml({
      title: subject,
      intro: 'A printer fault or alarm is active.',
      rows: [
        { label: 'Printer', value: name },
        { label: 'Status', value: payload.status },
        { label: 'Faults', value: faults },
        { label: 'Detected at', value: detectedAt }
      ],
      actionUrl: url,
      actionLabel: 'Open printer',
      tone: 'warning'
    })
  };
}

export { printerFaultEmail };

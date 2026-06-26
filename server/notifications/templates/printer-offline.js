import { formatDateTime, notificationHtml, printerName, printerUrl, valueOrDash } from './common.js';

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
    html: notificationHtml({
      title: subject,
      intro: 'A printer is offline or not responding to status polling.',
      rows: [
        { label: 'Printer', value: name },
        { label: 'Last successful update', value: lastSuccessfulAt },
        { label: 'Latest attempt', value: latestAttemptAt },
        { label: 'Connection detail', value: payload.errorMessage }
      ],
      actionUrl: url,
      actionLabel: 'Open printer',
      tone: 'warning'
    })
  };
}

export { printerOfflineEmail };

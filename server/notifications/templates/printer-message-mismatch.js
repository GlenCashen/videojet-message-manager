import { formatDateTime, notificationHtml, printerName, printerUrl, valueOrDash } from './common.js';

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
    html: notificationHtml({
      title: subject,
      intro: 'MESSAGE MISMATCH - STOP PRODUCTION. Stop the line and quarantine product since the mismatch was detected.',
      rows: [
        { label: 'Printer', value: name },
        { label: 'Expected message', value: payload.expectedMessage },
        { label: 'Current printer message', value: payload.currentMessage },
        { label: 'Detected at', value: detectedAt }
      ],
      actionUrl: url,
      actionLabel: 'Open printer',
      tone: 'danger'
    })
  };
}

export { printerMessageMismatchEmail };

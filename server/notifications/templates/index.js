import { printerFaultEmail } from './printer-fault.js';
import { printerMessageMismatchEmail } from './printer-message-mismatch.js';
import { printerOfflineEmail } from './printer-offline.js';
import { releasePendingReviewEmail } from './release-pending-review.js';
import { releaseRejectedEmail } from './release-rejected.js';

const RELEASE_PENDING_REVIEW = 'release.pending_review';
const RELEASE_REJECTED = 'release.rejected';
const PRINTER_MESSAGE_MISMATCH = 'printer.message_mismatch';
const PRINTER_OFFLINE = 'printer.offline';
const PRINTER_FAULT = 'printer.fault';

const NOTIFICATION_TEMPLATES = new Map([
  [RELEASE_PENDING_REVIEW, releasePendingReviewEmail],
  [RELEASE_REJECTED, releaseRejectedEmail],
  [PRINTER_MESSAGE_MISMATCH, printerMessageMismatchEmail],
  [PRINTER_OFFLINE, printerOfflineEmail],
  [PRINTER_FAULT, printerFaultEmail]
]);

function buildNotificationMessage(eventKey, payload = {}, config = {}) {
  const template = NOTIFICATION_TEMPLATES.get(eventKey);
  if (!template) throw new Error(`Unsupported notification event: ${eventKey}`);
  return template(payload, config);
}

function supportedNotificationEvents() {
  return [...NOTIFICATION_TEMPLATES.keys()];
}

export {
  NOTIFICATION_TEMPLATES,
  PRINTER_FAULT,
  PRINTER_MESSAGE_MISMATCH,
  PRINTER_OFFLINE,
  RELEASE_PENDING_REVIEW,
  RELEASE_REJECTED,
  buildNotificationMessage,
  printerFaultEmail,
  printerMessageMismatchEmail,
  printerOfflineEmail,
  releasePendingReviewEmail,
  releaseRejectedEmail,
  supportedNotificationEvents
};

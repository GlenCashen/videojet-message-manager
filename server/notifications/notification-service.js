import { createEmailTransport, emailConfigFromEnv } from './email-transport.js';
import {
  insertNotificationDelivery,
  listNotificationLists
} from '../repositories/notification-repository.js';
import { listUserRecords } from '../repositories/user-repository.js';
import {
  PRINTER_FAULT,
  PRINTER_MESSAGE_MISMATCH,
  PRINTER_OFFLINE,
  RELEASE_PENDING_REVIEW,
  RELEASE_REJECTED,
  buildNotificationMessage,
  releasePendingReviewEmail
} from './templates/index.js';

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function recipientExcluded(user, payload, eventKey) {
  if (eventKey !== RELEASE_PENDING_REVIEW) return false;
  const release = payload.release || {};
  if (release.createdByUserId && user.id) return release.createdByUserId === user.id;
  return String(release.createdByUsername || '').toLowerCase() === String(user.username || '').toLowerCase();
}

function resolveRecipients(list, payload, db, eventKey = RELEASE_PENDING_REVIEW) {
  const roleSet = new Set(list.recipientRoles || []);
  const userIdSet = new Set(list.recipientUserIds || []);
  const users = listUserRecords(db);
  const excludedEmails = new Set(users
    .filter((user) => user.email && recipientExcluded(user, payload, eventKey))
    .map((user) => user.email.toLowerCase()));
  if (eventKey === RELEASE_PENDING_REVIEW && payload.actor?.email) {
    excludedEmails.add(String(payload.actor.email).toLowerCase());
  }
  const fromUsers = users
    .filter((user) => user.enabled && user.email)
    .filter((user) => (
      userIdSet.has(user.id)
      || user.roles?.some((role) => roleSet.has(role))
    ))
    .filter((user) => !recipientExcluded(user, payload, eventKey))
    .map((user) => user.email);
  return unique([...fromUsers, ...(list.recipientEmails || [])])
    .filter((email) => !excludedEmails.has(email));
}

function createNotificationService({
  config = emailConfigFromEnv(),
  transport = createEmailTransport(config),
  db
} = {}) {
  async function notify(eventKey, payload = {}) {
    const lists = listNotificationLists({ eventKey }, db);
    const baseMessage = buildNotificationMessage(eventKey, payload, config);
    const results = [];

    for (const list of lists) {
      const recipients = resolveRecipients(list, payload, db, eventKey);
      const delivery = {
        eventKey,
        listId: list.id,
        targetType: payload.targetType || 'batch-release',
        targetId: payload.release?.id || payload.targetId || null,
        subject: baseMessage.subject,
        recipients
      };

      if (!recipients.length) {
        insertNotificationDelivery({ ...delivery, status: 'skipped', errorMessage: 'No recipients resolved.' }, db);
        results.push({ listId: list.id, status: 'skipped', recipients });
        continue;
      }

      try {
        const transportResult = await transport.send({
          to: recipients,
          subject: baseMessage.subject,
          text: baseMessage.text,
          html: baseMessage.html
        });
        const skipped = transportResult?.skipped;
        insertNotificationDelivery({
          ...delivery,
          status: skipped ? 'skipped' : 'sent',
          errorMessage: skipped ? transportResult.reason : null
        }, db);
        results.push({ listId: list.id, status: skipped ? 'skipped' : 'sent', recipients });
      } catch (error) {
        insertNotificationDelivery({ ...delivery, status: 'failed', errorMessage: error.message }, db);
        results.push({ listId: list.id, status: 'failed', recipients, error: error.message });
      }
    }

    return results;
  }

  return { notify };
}

const defaultNotificationService = createNotificationService();

function notifyReleasePendingReview(release, actor) {
  return defaultNotificationService.notify(RELEASE_PENDING_REVIEW, { release, actor });
}

function notifyReleaseRejected(release, actor) {
  return defaultNotificationService.notify(RELEASE_REJECTED, { release, actor });
}

export {
  PRINTER_FAULT,
  PRINTER_MESSAGE_MISMATCH,
  PRINTER_OFFLINE,
  RELEASE_PENDING_REVIEW,
  RELEASE_REJECTED,
  buildNotificationMessage,
  createNotificationService,
  releasePendingReviewEmail as buildReleasePendingReviewMessage,
  notifyReleasePendingReview,
  notifyReleaseRejected,
  resolveRecipients
};

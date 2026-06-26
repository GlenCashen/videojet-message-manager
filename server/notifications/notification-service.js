import { createEmailTransport, emailConfigFromEnv } from './email-transport.js';
import {
  insertNotificationDelivery,
  listNotificationLists
} from '../repositories/notification-repository.js';
import { listUserRecords } from '../repositories/user-repository.js';

const RELEASE_PENDING_REVIEW = 'release.pending_review';

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function releaseUrl(baseUrl, release) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  if (!root) return '/production-releases';
  return `${root}/production-releases?release=${encodeURIComponent(release.id)}`;
}

function recipientExcluded(user, payload) {
  const release = payload.release || {};
  if (release.createdByUserId && user.id) return release.createdByUserId === user.id;
  return String(release.createdByUsername || '').toLowerCase() === String(user.username || '').toLowerCase();
}

function resolveRecipients(list, payload, db) {
  const roleSet = new Set(list.recipientRoles || []);
  const userIdSet = new Set(list.recipientUserIds || []);
  const users = listUserRecords(db);
  const excludedEmails = new Set(users
    .filter((user) => user.email && recipientExcluded(user, payload))
    .map((user) => user.email.toLowerCase()));
  if (payload.actor?.email) excludedEmails.add(String(payload.actor.email).toLowerCase());
  const fromUsers = users
    .filter((user) => user.enabled && user.email)
    .filter((user) => (
      userIdSet.has(user.id)
      || user.roles?.some((role) => roleSet.has(role))
    ))
    .filter((user) => !recipientExcluded(user, payload))
    .map((user) => user.email);
  return unique([...fromUsers, ...(list.recipientEmails || [])])
    .filter((email) => !excludedEmails.has(email));
}

function buildReleasePendingReviewMessage(payload, config) {
  const { release, actor } = payload;
  const product = release.brewSheetProduct || release.id;
  const planned = release.plannedProductionAt ? new Date(release.plannedProductionAt).toLocaleString() : 'Not set';
  const url = releaseUrl(config.baseUrl, release);
  const subject = `Release needs approval: ${product}`;
  const text = [
    `A production coding release needs independent approval.`,
    '',
    `Product: ${product}`,
    `Brew: ${release.brewNumber || '-'}`,
    `Planned production: ${planned}`,
    `Submitted by: ${actor?.displayName || actor?.username || release.createdByUsername || '-'}`,
    `Release: ${url}`,
    '',
    'Open the Production Coding Releases page to review, approve, reject or return it for correction.'
  ].join('\n');
  return { subject, text };
}

function buildMessage(eventKey, payload, config) {
  if (eventKey === RELEASE_PENDING_REVIEW) return buildReleasePendingReviewMessage(payload, config);
  throw new Error(`Unsupported notification event: ${eventKey}`);
}

function createNotificationService({
  config = emailConfigFromEnv(),
  transport = createEmailTransport(config),
  db
} = {}) {
  async function notify(eventKey, payload = {}) {
    const lists = listNotificationLists({ eventKey }, db);
    const baseMessage = buildMessage(eventKey, payload, config);
    const results = [];

    for (const list of lists) {
      const recipients = resolveRecipients(list, payload, db);
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
          text: baseMessage.text
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

export {
  RELEASE_PENDING_REVIEW,
  buildReleasePendingReviewMessage,
  createNotificationService,
  notifyReleasePendingReview,
  resolveRecipients
};

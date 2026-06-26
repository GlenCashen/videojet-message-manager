import assert from 'node:assert/strict';
import test from 'node:test';

const { openDatabase, runMigrations } = await import('../server/db.js');
const { upsertUserRecord } = await import('../server/repositories/user-repository.js');
const { upsertNotificationList } = await import('../server/repositories/notification-repository.js');
const {
  PRINTER_FAULT,
  PRINTER_MESSAGE_MISMATCH,
  PRINTER_OFFLINE,
  RELEASE_PENDING_REVIEW,
  buildNotificationMessage,
  createNotificationService
} = await import('../server/notifications/notification-service.js');

function user(overrides) {
  return {
    id: overrides.id,
    username: overrides.username,
    displayName: overrides.displayName || overrides.username,
    email: overrides.email || null,
    roles: overrides.roles || ['viewer'],
    printerIds: [],
    enabled: overrides.enabled ?? true,
    mustChangePassword: false,
    passwordHash: 'test-hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null
  };
}

function release(overrides = {}) {
  return {
    id: 'release-1',
    brewSheetProduct: 'BBLOND-111',
    brewNumber: 'H0055',
    plannedProductionAt: '2026-06-26T13:00:00.000Z',
    createdByUserId: 'planner-1',
    createdByUsername: 'planner',
    ...overrides
  };
}

test('release approval notifications target reviewer lists and exclude the creator', async () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  test.after(() => db.close());

  upsertUserRecord(user({
    id: 'planner-1',
    username: 'planner',
    email: 'planner@example.test',
    roles: ['planner', 'qa']
  }), db);
  upsertUserRecord(user({
    id: 'qa-1',
    username: 'qa-reviewer',
    email: 'qa@example.test',
    roles: ['qa']
  }), db);
  upsertUserRecord(user({
    id: 'admin-1',
    username: 'admin',
    email: 'admin@example.test',
    roles: ['admin']
  }), db);
  upsertUserRecord(user({
    id: 'disabled-1',
    username: 'disabled-admin',
    email: 'disabled@example.test',
    roles: ['admin'],
    enabled: false
  }), db);

  const sent = [];
  const service = createNotificationService({
    db,
    config: { baseUrl: 'https://codes.example.test' },
    transport: {
      async send(message) {
        sent.push(message);
        return { accepted: message.to };
      }
    }
  });

  const results = await service.notify(RELEASE_PENDING_REVIEW, {
    release: release(),
    actor: { id: 'planner-1', username: 'planner', displayName: 'Planner' }
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'sent');
  assert.deepEqual(sent[0].to.sort(), ['admin@example.test', 'qa@example.test']);
  assert.match(sent[0].subject, /Release needs approval: BBLOND-111/);
  assert.match(sent[0].text, /https:\/\/codes\.example\.test\/production-releases\?release=release-1/);

  const deliveries = db.prepare('SELECT * FROM notification_deliveries').all();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].event_key, RELEASE_PENDING_REVIEW);
  assert.equal(deliveries[0].status, 'sent');
  assert.deepEqual(JSON.parse(deliveries[0].recipients_json).sort(), ['admin@example.test', 'qa@example.test']);
});

test('notification lists can target direct email recipients for future events', async () => {
  const db = openDatabase(':memory:');
  runMigrations(db);
  test.after(() => db.close());

  upsertNotificationList({
    id: 'shift-leads',
    name: 'Shift leads',
    eventKey: RELEASE_PENDING_REVIEW,
    recipientRoles: [],
    recipientUserIds: [],
    recipientEmails: ['Lead@One.Example', 'lead@one.example', 'lead-two@example.test']
  }, db);

  const sent = [];
  const service = createNotificationService({
    db,
    config: {},
    transport: {
      async send(message) {
        sent.push(message);
        return { accepted: message.to };
      }
    }
  });

  const results = await service.notify(RELEASE_PENDING_REVIEW, {
    release: release(),
    actor: { id: 'planner-1', username: 'planner' }
  });

  assert.equal(results.length, 2);
  assert.equal(results.find((item) => item.listId === 'release-reviewers').status, 'skipped');
  assert.deepEqual(
    sent.find((message) => message.to.includes('lead@one.example')).to.sort(),
    ['lead-two@example.test', 'lead@one.example']
  );
});

test('notification templates cover release and printer safety events', () => {
  const releaseMessage = buildNotificationMessage(RELEASE_PENDING_REVIEW, {
    release: release(),
    actor: { username: 'planner' }
  }, { baseUrl: 'https://codes.example.test' });
  assert.match(releaseMessage.subject, /Release needs approval/);
  assert.match(releaseMessage.text, /independent approval/i);

  const mismatchMessage = buildNotificationMessage(PRINTER_MESSAGE_MISMATCH, {
    printer: { id: 'coder-1', name: 'Can Coder' },
    expectedMessage: 'CAT CAN 12M CB7007',
    currentMessage: 'CAT CAN NOW A13FCD',
    detectedAt: '2026-06-26T05:19:04.000Z'
  }, { baseUrl: 'https://codes.example.test' });
  assert.match(mismatchMessage.subject, /Message mismatch: Can Coder/);
  assert.match(mismatchMessage.text, /MESSAGE MISMATCH - STOP PRODUCTION/);
  assert.match(mismatchMessage.text, /quarantine product/i);
  assert.match(mismatchMessage.text, /https:\/\/codes\.example\.test\/printers\/coder-1/);

  const offlineMessage = buildNotificationMessage(PRINTER_OFFLINE, {
    printer: { id: 'coder-2', name: 'Bottle Coder' },
    errorMessage: 'ECONNREFUSED 127.0.0.1:3101'
  }, {});
  assert.match(offlineMessage.subject, /Printer offline: Bottle Coder/);
  assert.match(offlineMessage.text, /network connection/i);

  const faultMessage = buildNotificationMessage(PRINTER_FAULT, {
    printer: { id: 'coder-3', name: 'Case Coder' },
    status: 'Red',
    faults: ['Gutter fault']
  }, {});
  assert.match(faultMessage.subject, /Printer fault: Case Coder/);
  assert.match(faultMessage.text, /Gutter fault/);
});

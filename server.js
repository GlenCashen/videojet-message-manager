import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createPrinter, deletePrinter, readPrinters, updatePrinter } from './printer-store.js';
import { createSessionManager } from './server/auth.js';
import { CoderQueue } from './server/coder-queue.js';
import { requestCurrentMessage } from './server/current-message.js';
import { EmulatorManager } from './server/emulator-manager.js';
import { ReadbackCapabilityRegistry } from './server/readback-capability-registry.js';
import { databaseStatus } from './server/db.js';
import {
  MessageUpdateError,
  enabledMessages,
  executeMessageUpdate,
  getMessageForPrinter,
  getMessageById,
  loadMessages,
  messagesForPrinter,
  renderPreview,
  saveMessages,
  validateMessageFields
} from './server/message-store.js';
import { Monitor } from './server/monitor.js';
import { NgpclClient } from './server/ngpcl-client.js';
import {
  loadPrinterState,
  persistedRecordFromExpected,
  restoredExpectedOutput,
  savePrinterState
} from './server/printer-state-store.js';
import { createFaultHistoryStore } from './server/fault-history-store.js';
import {
  canAccessDiagnostics,
  canConfigurePrinters,
  canEditMessages,
  canManageUsers,
  canOperatePrinter,
  canViewAudit,
  canViewDashboard,
  canViewEditor,
  canViewFaultHistory,
  canViewPrinter,
  developmentUser,
  getCapabilities,
  normalizeRole,
  visiblePrinters
} from './server/permissions.js';
import { StatusCache } from './server/status-cache.js';
import { seedCurrentConfiguration } from './server/seed-current-configuration.js';
import {
  authenticateUser,
  changePassword,
  createUser,
  ensureBootstrapAdmin,
  findUserById,
  listUsers,
  updateUser
} from './server/user-store.js';
import { insertAuditEvent, listAuditEvents } from './server/repositories/audit-repository.js';
import { insertMessageUpdateEvent } from './server/repositories/message-update-repository.js';
import { deleteMessage } from './server/repositories/message-repository.js';
import { withOperatorError } from './server/operator-error-messages.js';
import { createReleaseAuditService } from './server/services/release-audit-service.js';
import { createReleaseExecutionService } from './server/services/release-execution-service.js';
import { createPrinterRuntimeService } from './server/services/printer-runtime-service.js';
import {
  claimPrinterAgentJob,
  completePrinterAgentJob,
  enqueuePrinterAgentJob,
  getPrinterAgentJob
} from './server/repositories/printer-agent-job-repository.js';
import {
  createPrinterUserField,
  deletePrinterUserField,
  listPrinterUserFields,
  resolveMessageUserFields,
  updatePrinterUserField
} from './server/repositories/printer-user-field-repository.js';
import {
  createProductMaster,
  getProductMaster,
  listProductMasters,
  updateProductMaster
} from './server/repositories/product-master-repository.js';
import {
  approveBatchRelease,
  beginBatchReleaseTarget,
  claimBatchReleaseReview,
  createBatchRelease,
  deleteDraftBatchRelease,
  endBatchReleaseTargetRun,
  endOtherRunningTargets,
  finishBatchReleaseTarget,
  getBatchRelease,
  listBatchReleases,
  listBatchReleasesPage,
  recoverInterruptedBatchReleaseTargets,
  rejectBatchRelease,
  releaseBatchReleaseReview,
  reserveBatchReleaseRun,
  returnBatchReleaseForReview,
  submitBatchRelease,
  updateBatchRelease,
  verifyBatchReleaseTarget
} from './server/repositories/batch-release-repository.js';
import { WsiClient } from './server/wsi-client.js';
import { assertPacketResponse, failureMessage } from './server/wsi-response.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 8080);
const DEFAULT_PRINTER_IP = process.env.PRINTER_IP || '192.168.100.2';
const DEFAULT_PRINTER_PORT = Number(process.env.PRINTER_PORT || 3100);
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 5000);
const BETWEEN_COMMAND_DELAY_MS = Number(process.env.BETWEEN_COMMAND_DELAY_MS || 150);
const BETWEEN_CODER_DELAY_MS = Number(process.env.BETWEEN_CODER_DELAY_MS || 300);
const EMULATOR_HOST = process.env.EMULATOR_HOST || '127.0.0.1';
const EMULATOR_PORT = Number(process.env.EMULATOR_PORT || 3100);
const EMULATOR_PORT_OFFSET = process.env.EMULATOR_PORT ? EMULATOR_PORT - 3100 : 0;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || process.env.STATUS_POLL_MS || 5000);
const STALE_AFTER_MS = Number(process.env.STALE_AFTER_MS || 15000);
const OFFLINE_AFTER_FAILURES = Number(process.env.OFFLINE_AFTER_FAILURES || 3);
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 20000);
const ENABLE_UNSAFE_DEVELOPMENT_TOOLS = process.env.ENABLE_UNSAFE_DEVELOPMENT_TOOLS === 'true';
const ENABLE_TEST_ENDPOINTS = process.env.NODE_ENV === 'test' || process.env.ENABLE_TEST_ENDPOINTS === 'true';
const ENABLE_DEV_IDENTITY = process.env.ENABLE_DEV_IDENTITY === 'true';
const DEV_USER_ROLE = process.env.DEV_USER_ROLE || 'viewer';
const DEV_USER_PRINTER_IDS = (process.env.DEV_USER_PRINTER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PRINTER_EXECUTION_MODE = process.env.PRINTER_EXECUTION_MODE || (IS_PRODUCTION ? 'agent' : 'local');
const FAULT_HISTORY_LIMIT = Number(process.env.FAULT_HISTORY_LIMIT || 1000);
const FAULT_HISTORY_PATH = process.env.FAULT_HISTORY_PATH || undefined;
const FAULT_HISTORY_API_MAX_LIMIT = 500;
if (!['local', 'agent'].includes(PRINTER_EXECUTION_MODE)) throw new Error('PRINTER_EXECUTION_MODE must be local or agent.');

function printerAgentCredentials() {
  if (process.env.PRINTER_AGENT_CREDENTIALS) {
    const parsed = JSON.parse(process.env.PRINTER_AGENT_CREDENTIALS);

    return new Map(Object.entries(parsed).map(([agentId, value]) => [agentId, {
      tokenHash: crypto
        .createHash('sha256')
        .update(String(value.token || ''))
        .digest('hex'),

      printerIds: Array.isArray(value.printerIds)
        ? value.printerIds.map(String)
        : ['*']
    }]));
  }

  if (process.env.PRINTER_AGENT_TOKEN) {
    return new Map([[process.env.PRINTER_AGENT_ID || 'printer-agent-1', {
      tokenHash: crypto
        .createHash('sha256')
        .update(process.env.PRINTER_AGENT_TOKEN)
        .digest('hex'),

      printerIds: String(process.env.PRINTER_AGENT_PRINTER_IDS || '*')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    }]]);
  }

  return new Map();
}

const configuredPrinterAgents = printerAgentCredentials();
const REQUIRE_AGENT_MTLS = process.env.REQUIRE_AGENT_MTLS === 'true';
if (IS_PRODUCTION && PRINTER_EXECUTION_MODE === 'agent' && !configuredPrinterAgents.size) {
  throw new Error('At least one printer-agent credential is required in production agent mode.');
}
const auth = createSessionManager({
  secret: SESSION_SECRET || undefined,
  secure: IS_PRODUCTION
});
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
await seedCurrentConfiguration();
const recoveredReleaseExecutions = PRINTER_EXECUTION_MODE === 'local' ? recoverInterruptedBatchReleaseTargets() : 0;
if (recoveredReleaseExecutions) {
  console.warn(`${recoveredReleaseExecutions} interrupted release execution(s) require operator attention.`);
}
const startupPrinters = await readPrinters();
const bootstrap = await ensureBootstrapAdmin({ printers: startupPrinters, enableDevIdentity: ENABLE_DEV_IDENTITY });
if (IS_PRODUCTION && !ENABLE_DEV_IDENTITY && bootstrap.users.length && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required when development identity is disabled.');
}
if (!IS_PRODUCTION && !ENABLE_DEV_IDENTITY && bootstrap.users.length && !SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set; using the database-managed local session secret.');
}
if (bootstrap.created) {
  console.log(`Bootstrap admin created for ${bootstrap.users[0].username}. Password must be changed on first login.`);
}

app.use(express.json({ limit: '32kb' }));

function requirePrinterAgent(req, res) {
  const agentId = String(req.get('x-printer-agent-id') || '').trim();
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const credential = configuredPrinterAgents.get(agentId);
  const suppliedHash = crypto.createHash('sha256').update(token).digest();
  const expectedHash = credential ? Buffer.from(credential.tokenHash, 'hex') : crypto.randomBytes(32);
  if (!credential || !token || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
    res.status(401).json({ ok: false, error: 'Printer-agent authentication failed.' });
    return null;
  }
  if (REQUIRE_AGENT_MTLS && req.get('x-client-cert-verified') !== 'SUCCESS') {
    res.status(401).json({ ok: false, error: 'A verified printer-agent client certificate is required.' });
    return null;
  }
  return { id: agentId, printerIds: credential.printerIds };
}

app.get('/', (_req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
  const user = currentUser(req);
  if (user && !user.mustChangePassword) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/change-password', (req, res) => {
  const user = currentUser(req);
  if (!user) return redirectToLogin(req, res);
  res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});

app.get('/dashboard', (req, res) => {
  const user = currentUser(req);
  if (!user) return redirectToLogin(req, res);
  if (user.mustChangePassword) return res.redirect('/change-password');
  if (!canViewDashboard(user)) return res.status(403).send('You do not have permission to view the dashboard.');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/editor', (req, res) => {
  const user = currentUser(req);
  if (!user) return redirectToLogin(req, res);
  if (user.mustChangePassword) return res.redirect('/change-password');
  if (!canViewEditor(user)) return res.status(403).send('You do not have permission to view the editor.');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/production-releases', (req, res) => {
  const user = currentUser(req);
  if (!user) return redirectToLogin(req, res);
  if (user.mustChangePassword) return res.redirect('/change-password');
  if (!getCapabilities(user).viewBatchReleases) return res.status(403).send('You do not have permission to view production releases.');
  res.sendFile(path.join(__dirname, 'public', 'production-releases.html'));
});

app.get('/editor/:section', (req, res) => {
  const user = currentUser(req);
  if (!user) return redirectToLogin(req, res);
  if (user.mustChangePassword) return res.redirect('/change-password');
  if (!canViewEditor(user)) return res.status(403).send('You do not have permission to view the editor.');
  if (req.params.section === 'users' && !canManageUsers(user)) {
    return res.status(403).send('You do not have permission to manage users.');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/printers/:printerId', async (req, res) => {
  const user = currentUser(req);
  if (!user) return redirectToLogin(req, res);
  if (user.mustChangePassword) return res.redirect('/change-password');
  if (!canViewPrinter(user, req.params.printerId)) return res.status(403).send('You do not have permission to view this printer.');
  const printers = await readPrinters();
  if (!printers.some((printer) => printer.id === req.params.printerId)) return res.status(404).send('Printer not found.');
  res.sendFile(path.join(__dirname, 'public', 'printer.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const commandLog = [];
const MAX_LOG_ENTRIES = 200;
const eventClients = new Set();
const coderQueue = new CoderQueue();
const wsiClient = new WsiClient({ timeoutMs: COMMAND_TIMEOUT_MS });
const ngpclClient = new NgpclClient({ timeoutMs: COMMAND_TIMEOUT_MS });
const readbackCapabilities = new ReadbackCapabilityRegistry();
const stateChangingOperations = new Set();
const printerAgentHeartbeats = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emulatorManager = new EmulatorManager({
  host: EMULATOR_HOST,
  portOffset: EMULATOR_PORT_OFFSET,
  delay,
  onError: (message) => console.error(message)
});
async function syncEmulatorManager(printers, knownMessages = null) {
  if (PRINTER_EXECUTION_MODE !== 'local') return;
  await emulatorManager.sync(printers);
  const messages = knownMessages || await loadMessages(undefined, { printers });
  for (const printer of printers.filter((item) => item.mode === 'emulator')) {
    const assigned = messages.filter((message) => message.enabled && message.printerAssignments?.some((assignment) => assignment.enabled && assignment.printerId === printer.id));
    emulatorManager.configurePrinter(printer.id, {
      messageNames: assigned.flatMap((message) => message.printerAssignments
        .filter((assignment) => assignment.enabled && assignment.printerId === printer.id)
        .map((assignment) => assignment.printerMessageName)),
      fieldNames: assigned.flatMap((message) => message.fields.map((field) => field.printerFieldName))
    });
  }
}

if (PRINTER_EXECUTION_MODE === 'local') await syncEmulatorManager(startupPrinters);
let persistedPrinterState = await loadPrinterState();
const faultHistory = await createFaultHistoryStore({ filePath: FAULT_HISTORY_PATH, limit: FAULT_HISTORY_LIMIT });

function addLog(entry) {
  const logEntry = { time: new Date().toISOString(), ...entry };
  commandLog.unshift(logEntry);
  if (commandLog.length > MAX_LOG_ENTRIES) commandLog.length = MAX_LOG_ENTRIES;
  try {
    insertAuditEvent(logEntry);
  } catch (error) {
    console.error(`Audit insert failed: ${error.message}`);
  }
  broadcast('log-entry', logEntry);
}

if (recoveredReleaseExecutions) {
  for (const release of listBatchReleases({ limit: 500, statuses: ['failed'] })) {
    const interruptedTargets = release.executionTargets.filter((target) => target.error?.startsWith('Server restarted during message application.'));
    for (const target of interruptedTargets) {
      addLog({
        action: 'batch-release-printer-state-uncertain', actor: 'System', targetType: 'batch-release',
        targetId: release.id, printerId: target.printerId,
        details: { printerId: target.printerId, reason: target.error, status: 'failed', recovery: 'server-restart', ok: false }
      });
    }
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [key, ...value] = part.split('=');
      return [decodeURIComponent(key), decodeURIComponent(value.join('='))];
    }));
}

function redirectToLogin(req, res) {
  const returnTo = encodeURIComponent(req.originalUrl || '/dashboard');
  return res.redirect(`/login?returnTo=${returnTo}`);
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeDevelopmentPrinterIds(values, printers, role) {
  const ids = uniqueValues(values);
  if (ids.includes('*')) return ['*'];
  if (role === 'operator' && !ids.length) {
    const firstEnabled = printers.find((printer) => printer.enabled) || printers[0];
    return firstEnabled ? [firstEnabled.id] : [];
  }
  const known = new Set(printers.map((printer) => printer.id));
  for (const id of ids) {
    if (!known.has(id)) {
      const error = new Error(`Unknown printer id: ${id}`);
      error.code = 'UNKNOWN_PRINTER';
      throw error;
    }
  }
  return ids;
}

function devIdentityFromRequest(req) {
  if (!ENABLE_DEV_IDENTITY) return null;
  const cookies = parseCookies(req.headers.cookie || '');
  const role = normalizeRole(cookies.devRole || DEV_USER_ROLE);
  if (!role) return null;
  let printerIds = uniqueValues((cookies.devPrinterIds || DEV_USER_PRINTER_IDS.join(',')).split(','));
  if (printerIds.includes('*')) printerIds = ['*'];
  if (role === 'operator' && !printerIds.length) {
    const firstEnabled = startupPrinters.find((printer) => printer.enabled) || startupPrinters[0];
    printerIds = firstEnabled ? [firstEnabled.id] : [];
  }
  return developmentUser({ role, printerIds });
}

function realAuthenticatedUser(req) {
  return auth.read(parseCookies(req.headers.cookie || '')[auth.cookieName]);
}

function simulatedUserFromRequest(req, realUser = realAuthenticatedUser(req)) {
  if (!realUser?.roles?.includes('admin')) return null;
  const cookies = parseCookies(req.headers.cookie || '');
  return auth.readSimulation(cookies[auth.simulationCookieName]);
}

function currentUser(req) {
  const developmentUser = devIdentityFromRequest(req);
  if (developmentUser) return developmentUser;
  const realUser = realAuthenticatedUser(req);
  return simulatedUserFromRequest(req, realUser) || realUser;
}

function sessionPayload(req) {
  const user = currentUser(req);
  const realUser = realAuthenticatedUser(req);
  const simulationActive = Boolean(realUser && user && realUser.id !== user.id);
  return {
    authenticated: Boolean(user),
    user,
    capabilities: getCapabilities(user),
    devIdentityEnabled: ENABLE_DEV_IDENTITY,
    developmentIdentityActive: Boolean(user?.developmentIdentity),
    simulationActive,
    realUser: simulationActive ? {
      id: realUser.id,
      username: realUser.username,
      displayName: realUser.displayName,
      roles: realUser.roles
    } : null,
    passwordChangeRequired: Boolean(user?.mustChangePassword)
  };
}

function forbidden(res, message = 'You do not have permission to access this resource.') {
  return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: message });
}

function safeReturnTo(value) {
  const target = String(value || '/dashboard');
  if (!target.startsWith('/') || target.startsWith('//')) return '/dashboard';
  if (target.startsWith('/api/')) return '/dashboard';
  return target;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: 'No authenticated user is available.' });
    return null;
  }
  if (user.mustChangePassword && req.path !== '/api/auth/change-password') {
    res.status(403).json({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED', error: 'Password change is required before continuing.' });
    return null;
  }
  return user;
}

function canReceiveEvent(user, type, payload) {
  if (!user) return false;
  if (['connected', 'heartbeat'].includes(type)) return true;
  if (['logs-snapshot', 'log-entry'].includes(type)) return canViewAudit(user) || canAccessDiagnostics(user);
  if (['emulator-snapshot', 'stream-error'].includes(type)) return canAccessDiagnostics(user);
  if (type === 'messages-updated') return canEditMessages(user);
  if (['batch-release-presence', 'batch-release-changed'].includes(type)) return getCapabilities(user).viewBatchReleases;

  const printerId = payload?.printerId || payload?.id;
  if (printerId) return canViewPrinter(user, printerId);
  return true;
}

function filterEventPayload(user, type, payload) {
  if (!canReceiveEvent(user, type, payload)) return null;
  if (type === 'status-snapshot') return payload.filter((status) => canViewPrinter(user, status.printerId || status.id));
  if (type === 'fleet-snapshot') return visiblePrinters(user, payload).map(printerForClient);
  return payload;
}

function dateRuleAmount(rule = {}) {
  return rule.type === 'offset-days'
    ? Number(rule.days ?? rule.months ?? 0)
    : Number(rule.months ?? 0);
}

function sameDateRule(left = {}, right = {}) {
  return (left.type || 'offset-months') === (right.type || 'offset-months')
    && dateRuleAmount(left) === dateRuleAmount(right)
    && (left.format || 'DD/MM/YYYY') === (right.format || 'DD/MM/YYYY');
}

const releaseAudit = createReleaseAuditService({ addLog, auditActor });

const releaseExecutionService = createReleaseExecutionService({
  canOperatePrinter,
  readPrinters,
  loadMessages,
  getMessageForPrinter,
  renderPreview,
  sameDateRule,
  reserveBatchReleaseRun,
  beginBatchReleaseTarget,
  finishBatchReleaseTarget,
  endOtherRunningTargets,
  verifyBatchReleaseTarget,
  endBatchReleaseTargetRun
});

const printerRuntimeService = createPrinterRuntimeService({
  insertMessageUpdateEvent,
  persistExpectedOutput,
  releaseAudit,
  releaseExecutionService,
  setPrinterMessage
});

function broadcast(type, payload) {
  for (const client of eventClients) {
    const filteredPayload = filterEventPayload(client.user, type, payload);
    if (filteredPayload === null) continue;
    const data = JSON.stringify({ type, payload: filteredPayload });
    try {
      client.response.write(`event: ${type}\ndata: ${data}\n\n`);
    } catch (_error) {
      eventClients.delete(client);
    }
  }
}

function sendEvent(client, type, payload) {
  client.write(`event: ${type}\ndata: ${JSON.stringify({ type, payload })}\n\n`);
}

const activeReleaseMismatchKeys = new Set();

function expectedMessageMismatch(status) {
  const expected = status?.expectedOutput?.printerMessageName || null;
  const actual = status?.selectedMessage || null;
  if (!expected || !actual || status?.messageVerification === 'unsupported') return null;
  if (expected === actual) return null;
  return { expected, actual };
}

function runningReleaseForPrinter(printerId) {
  return listBatchReleases({ limit: 500 })
    .find((release) => release.executionTargets?.some((target) => target.printerId === printerId && target.status === 'running')) || null;
}

function recordReleaseMessageMismatch(status) {
  const mismatch = expectedMessageMismatch(status);
  const release = runningReleaseForPrinter(status.printerId);
  const key = release ? `${release.id}:${status.printerId}` : `printer:${status.printerId}`;
  if (!mismatch) {
    activeReleaseMismatchKeys.delete(key);
    return;
  }
  if (activeReleaseMismatchKeys.has(key)) return;
  activeReleaseMismatchKeys.add(key);
  addLog({
    action: 'batch-release-message-mismatch',
    actor: 'System',
    targetType: release ? 'batch-release' : 'printer',
    targetId: release?.id || status.printerId,
    printerId: status.printerId,
    selectedMessage: mismatch.actual,
    requestedMessage: mismatch.expected,
    details: {
      printerId: status.printerId,
      releaseId: release?.id || null,
      runCode: release?.runCode || null,
      expectedMessage: mismatch.expected,
      selectedMessage: mismatch.actual,
      instruction: 'STOP PRODUCTION. Printer message does not match the approved release. Quarantine product since detection, resend the release, and reverify the first print.',
      ok: false
    }
  });
}

const statusCache = new StatusCache({
  staleAfterMs: STALE_AFTER_MS,
  offlineAfterFailures: OFFLINE_AFTER_FAILURES,
  onChange: (event, status) => broadcast(event, status),
  onTransition: (transition, status) => {
    addLog({ action: 'printer-state-transition', printerId: status.printerId, transition, ok: true });
  },
  onStatusSuccess: (status) => {
    recordFaultTransitions(status);
    recordReleaseMessageMismatch(status);
  }
});

async function recordFaultTransitions(status) {
  try {
    const events = await faultHistory.recordStatus(status);
    for (const event of events) {
      broadcast(event.event === 'activated' ? 'fault-activated' : 'fault-cleared', event);
    }
  } catch (error) {
    addLog({ action: 'fault-history-error', printerId: status.printerId, ok: false, error: error.message });
  }
}

function syncStatusPrinters(printers) {
  statusCache.syncPrinters(printers);
  for (const printer of printers) {
    const record = persistedPrinterState[printer.id];
    if (record && !statusCache.get(printer.id).expectedOutput) {
      statusCache.restoreExpectedOutput(printer.id, restoredExpectedOutput(record));
    }
  }
}

async function persistExpectedOutput(printerId, expectedOutput) {
  if (!expectedOutput) return;
  persistedPrinterState = {
    ...persistedPrinterState,
    [printerId]: persistedRecordFromExpected(expectedOutput)
  };
  await savePrinterState(persistedPrinterState);
  statusCache.restoreExpectedOutput(printerId, expectedOutput);
}

function validateAscii(value, label, maxLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new Error(`${label} must be 1-${maxLength} characters.`);
  }
  if (!/^[\x20-\x7E]+$/.test(value)) {
    throw new Error(`${label} must contain printable ASCII characters only.`);
  }
}

function printerConfig(body = {}) {
  const ip = body.ip || DEFAULT_PRINTER_IP;
  const port = Number(body.port || DEFAULT_PRINTER_PORT);
  if (!net.isIP(ip)) throw new Error('Invalid printer IP address.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid printer TCP port.');
  return { ip, port };
}

function printerTarget(printer) {
  if (PRINTER_EXECUTION_MODE !== 'local') {
    const error = new Error('Direct printer communication is disabled on the main server.');
    error.statusCode = 503;
    throw error;
  }
  if (printer.mode === 'emulator') return emulatorManager.endpoint(printer);
  return { ip: printer.host, port: printer.port };
}

function runtimePrinterCapabilities(printer) {
  return readbackCapabilities.resolve(printer);
}

function printerProtocol(printer) {
  return printer.protocol || 'wsi';
}

function clientForPrinter(printer) {
  return printerProtocol(printer) === 'ngpcl' ? ngpclClient : wsiClient;
}

function printerForClient(printer) {
  return { ...printer, capabilities: runtimePrinterCapabilities(printer) };
}

async function readCurrentMessageForPrinter(printer, target, { force = false, suppressAutoFailure = false } = {}) {
  const capabilities = runtimePrinterCapabilities(printer);
  if (printerProtocol(printer) === 'ngpcl') {
    return requestCurrentMessage(ngpclClient, { printerId: printer.id, ...target, protocol: 'ngpcl' });
  }
  const isAuto1710 = printer.model === '1710' && capabilities.currentMessageReadbackMode === 'auto';
  const shouldAttempt = capabilities.currentMessageReadback === true || readbackCapabilities.shouldProbe(printer, { force });
  if (!shouldAttempt) return null;

  try {
    const response = await requestCurrentMessage(wsiClient, { printerId: printer.id, ...target });
    if (isAuto1710) {
      const wasSupported = capabilities.currentMessageReadback === true;
      readbackCapabilities.record(printer.id, true);
      if (!wasSupported) addLog({ action: 'current-message-capability-detected', printerId: printer.id, model: printer.model, supported: true, ok: true });
    }
    return response;
  } catch (error) {
    if (!isAuto1710) throw error;
    readbackCapabilities.record(printer.id, false, error);
    addLog({
      action: 'current-message-capability-detected',
      printerId: printer.id,
      model: printer.model,
      supported: false,
      error: error.message,
      rawCode: error.rawCode || null,
      rawResponseHex: error.rawResponseHex || null,
      ok: false
    });
    if (suppressAutoFailure) return null;
    throw error;
  }
}

function parseFaultQuery(query = {}) {
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > FAULT_HISTORY_API_MAX_LIMIT) {
    const error = new Error(`limit must be an integer from 1-${FAULT_HISTORY_API_MAX_LIMIT}.`);
    error.statusCode = 400;
    throw error;
  }

  const activeOnly = query.active === 'true';
  if (query.active !== undefined && query.active !== 'true' && query.active !== 'false') {
    const error = new Error('active must be true or false.');
    error.statusCode = 400;
    throw error;
  }

  for (const key of ['from', 'to']) {
    if (query[key] !== undefined && Number.isNaN(new Date(query[key]).valueOf())) {
      const error = new Error(`${key} must be an ISO timestamp.`);
      error.statusCode = 400;
      throw error;
    }
  }

  return {
    limit,
    activeOnly,
    from: query.from || null,
    to: query.to || null
  };
}

function operationId(prefix, printerId) {
  return `${prefix}-${printerId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function runCoderOperation(printer, operation, task) {
  const id = operationId(operation, printer.id);
  return coderQueue.run(printer.id, { operation, operationId: id }, async () => {
    statusCache.startOperation(printer.id, operation, id);
    try {
      const result = await task(id);
      statusCache.completeOperation(printer.id);
      const finalStatus = statusCache.get(printer.id);
      return {
        ...result,
        busy: finalStatus.busy,
        currentOperation: finalStatus.currentOperation,
        currentOperationId: finalStatus.currentOperationId,
        revision: finalStatus.revision
      };
    } catch (error) {
      const operationFailed = error instanceof MessageUpdateError && error.result;
      if (!operationFailed || !error.communicationSucceeded) {
        statusCache.applyFailure(printer.id, error.refreshError || error);
      }
      statusCache.completeOperation(printer.id);
      if (operationFailed) {
        const status = statusCache.get(printer.id);
        const result = withOperatorError({
          ...error.result,
          printerOnline: status.online,
          selectedMessage: error.result.selectedMessage || status.selectedMessage,
          status: error.result.status || {
            online: status.online,
            stale: status.stale,
            selectedMessage: status.selectedMessage,
            rawStatus: status.rawStatus,
            decodedStatus: status.decodedStatus,
            lastSuccessfulAt: status.lastSuccessfulAt,
            consecutiveFailures: status.consecutiveFailures,
            lastError: status.lastError
          }
        });
        broadcast('operation-failed', result);
        broadcast('printer-status', status);
        error.result = result;
      } else {
        broadcast('operation-failed', { ...statusCache.get(printer.id), error: error.message });
      }
      throw error;
    }
  });
}

async function refreshPrinterStatus(printer, operation = 'check') {
  const target = printerTarget(printer);
  return runCoderOperation(printer, operation, async (id) => {
    const startedAt = Date.now();
    const message = await readCurrentMessageForPrinter(printer, target, { suppressAutoFailure: true });
    if (message) await delay(BETWEEN_COMMAND_DELAY_MS);
    const protocol = printerProtocol(printer);
    const status = protocol === 'ngpcl'
      ? await ngpclClient.sendCommand({ printerId: printer.id, ...target, command: '{~DR|}' })
      : assertPacketResponse('E', await wsiClient.sendCommand({ printerId: printer.id, ...target, command: 'E' }));
    const responseTimeMs = Date.now() - startedAt;
    const capabilities = runtimePrinterCapabilities(printer);
    const cached = statusCache.applySuccess(printer.id, {
      ...(message ? { selectedMessage: message.currentMessage } : {}),
      messageVerification: message ? 'verified' : 'unsupported',
      rawStatus: status.value,
      protocol,
      responseTimeMs
    });

    return {
      ...cached,
      id: printer.id,
      operationId: id,
      name: printer.name,
      location: printer.location,
      host: printer.host,
      port: printer.port,
      targetHost: target.ip,
      targetPort: target.port,
      mode: printer.mode,
      protocol,
      model: printer.model,
      capabilities,
      enabled: printer.enabled,
      status: status.value,
      checkedAt: cached.lastSuccessfulAt,
      elapsedMs: responseTimeMs
    };
  });
}

async function resolvePrinterMessageRequest(printer, body) {
  let message;
  let fields;
  try {
    const printers = await readPrinters();
    const messages = await loadMessages(undefined, { printers });
    message = getMessageForPrinter(messages, body.messageId, printer.id);
    fields = validateMessageFields(message, body.fields || {});
  } catch (error) {
    error.statusCode = error.statusCode || 400;
    throw error;
  }
  return { message, fields };
}

function printerAgentMessage(message) {
  return {
    id: message.id,
    displayName: message.displayName,
    printerMessageName: message.printerMessageName,
    fields: message.fields,
    dateRule: message.dateRule,
    timeRule: message.timeRule,
    previewLines: message.previewLines
  };
}

async function setPrinterMessage(printer, body) {
  const { message, fields } = await resolvePrinterMessageRequest(printer, body);
  const target = printerTarget(printer);
  const capabilities = runtimePrinterCapabilities(printer);
  const client = clientForPrinter(printer);

  return runCoderOperation(printer, 'message-update', async (id) =>
    executeMessageUpdate({
      printer,
      target,
      message,
      fields,
      operationId: id,
      productionDate: body.productionDate,
      supportsCurrentMessageReadback: capabilities.currentMessageReadback === true,
      sendCommand: (command) => client.sendCommand(command),
      delay: () => delay(BETWEEN_COMMAND_DELAY_MS),
      applySuccess: (status) => statusCache.applySuccess(printer.id, status)
    })
  );
}

app.get('/api/config', (_req, res) => {
  res.json({
    printerExecutionMode: PRINTER_EXECUTION_MODE,
    printerIp: DEFAULT_PRINTER_IP,
    printerPort: DEFAULT_PRINTER_PORT,
    timeoutMs: COMMAND_TIMEOUT_MS,
    emulatorIp: EMULATOR_HOST,
    emulatorPort: EMULATOR_PORT
  });
});

app.get('/api/health', (_req, res) => {
  try {
    res.json({
      ok: true,
      database: databaseStatus(),
      printerExecutionMode: PRINTER_EXECUTION_MODE,
      printerAgents: [...printerAgentHeartbeats.values()]
    });
  } catch (_error) {
    res.status(500).json({ ok: false, database: { connected: false } });
  }
});

app.get('/api/session', (req, res) => {
  res.json(sessionPayload(req));
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const user = await authenticateUser(req.body?.username, req.body?.password);
    if (!user) {
      return res.status(401).json({ ok: false, code: 'INVALID_LOGIN', error: 'Username or password is incorrect.' });
    }
    const token = auth.create(user);
    res.setHeader('Set-Cookie', [auth.cookie(token), auth.clearSimulationCookie()]);
    res.json({
      ok: true,
      authenticated: true,
      user,
      capabilities: getCapabilities(user),
      passwordChangeRequired: Boolean(user.mustChangePassword),
      redirectTo: user.mustChangePassword ? '/change-password' : safeReturnTo(req.body?.returnTo)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  auth.destroy(cookies[auth.cookieName]);
  res.setHeader('Set-Cookie', [auth.clearCookie(), auth.clearSimulationCookie()]);
  res.json({ ok: true, redirectTo: '/login' });
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const user = realAuthenticatedUser(req);
    if (!user || user.developmentIdentity) {
      return res.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: 'No authenticated user is available.' });
    }
    const updated = await changePassword(user.id, req.body?.currentPassword, req.body?.newPassword);
    if (!updated) {
      return res.status(400).json({ ok: false, code: 'PASSWORD_CHANGE_FAILED', error: 'Current password is incorrect.' });
    }
    const cookies = parseCookies(req.headers.cookie || '');
    auth.destroy(cookies[auth.cookieName]);
    const token = auth.create(updated);
    res.setHeader('Set-Cookie', [auth.cookie(token), auth.clearSimulationCookie()]);
    res.json({ ok: true, user: updated, capabilities: getCapabilities(updated), redirectTo: '/dashboard' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/dev/session', async (req, res) => {
  if (!ENABLE_DEV_IDENTITY) return forbidden(res, 'Development identity switching is disabled.');
  const role = normalizeRole(req.body?.role);
  if (!role) return res.status(400).json({ ok: false, error: 'Unsupported development role.' });
  const rawPrinterIds = Array.isArray(req.body?.printerIds)
    ? req.body.printerIds
    : String(req.body?.printerIds || '').split(',');
  let printerIds;
  try {
    printerIds = normalizeDevelopmentPrinterIds(rawPrinterIds, await readPrinters(), role);
  } catch (error) {
    return res.status(400).json({ ok: false, code: error.code || 'INVALID_PRINTER_ASSIGNMENT', error: error.message });
  }
  res.setHeader('Set-Cookie', [
    `devRole=${encodeURIComponent(role)}; Path=/; SameSite=Lax`,
    `devPrinterIds=${encodeURIComponent(printerIds.join(','))}; Path=/; SameSite=Lax`
  ]);
  res.json({ ok: true });
});

app.post('/api/admin/simulate-user', async (req, res) => {
  try {
    const admin = realAuthenticatedUser(req);
    if (!admin?.roles?.includes('admin')) return forbidden(res, 'A real admin session is required to simulate a user.');
    const target = await findUserById(req.body?.userId);
    if (!target || !target.enabled) return res.status(404).json({ ok: false, error: 'The selected enabled user was not found.' });
    if (target.mustChangePassword) return res.status(409).json({ ok: false, error: 'Set the user password before starting simulation.' });
    if (target.id === admin.id) return res.status(400).json({ ok: false, error: 'Select a different user to simulate.' });
    res.setHeader('Set-Cookie', auth.simulationCookie(target.id));
    addLog({ action: 'user-simulation-started', actor: admin.username, targetId: target.id, username: target.username, ok: true });
    res.json({ ok: true, user: target, redirectTo: '/dashboard' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete('/api/admin/simulate-user', (req, res) => {
  const admin = realAuthenticatedUser(req);
  if (!admin?.roles?.includes('admin')) return forbidden(res, 'A real admin session is required to stop simulation.');
  res.setHeader('Set-Cookie', auth.clearSimulationCookie());
  addLog({ action: 'user-simulation-stopped', actor: admin.username, ok: true });
  res.json({ ok: true, redirectTo: '/editor#users' });
});

app.get('/api/logs', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!canViewAudit(user) && !canAccessDiagnostics(user)) return forbidden(res, 'You do not have permission to view logs.');
  res.json(commandLog);
});

app.get('/api/audit', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!canViewAudit(user)) return forbidden(res, 'You do not have permission to view audit records.');
  res.json(listAuditEvents(req.query));
});

app.get('/api/users', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!canManageUsers(user)) return forbidden(res, 'You do not have permission to manage users.');
  res.json(await listUsers());
});

app.post('/api/users', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canManageUsers(user)) return forbidden(res, 'You do not have permission to manage users.');
    const created = await createUser(req.body || {}, { printers: await readPrinters() });
    addLog({ action: 'user-created', actor: user.username, username: created.username, ok: true });
    res.status(201).json({ ok: true, user: created });
  } catch (error) {
    res.status(error.code === 'UNKNOWN_PRINTER' ? 400 : 400).json({ ok: false, code: error.code, error: error.message });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canManageUsers(user)) return forbidden(res, 'You do not have permission to manage users.');
    const updated = await updateUser(req.params.id, req.body || {}, { printers: await readPrinters() });
    addLog({ action: 'user-updated', actor: user.username, username: updated.username, ok: true });
    res.json({ ok: true, user: updated });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, code: error.code, error: error.message });
  }
});

async function emulatorPrinterForRequest(req) {
  const printerId = req.query?.printerId || req.body?.printerId;
  const printers = await readPrinters();
  const printer = printerId
    ? printers.find((item) => item.id === printerId)
    : printers.find((item) => item.mode === 'emulator');
  if (!printer) {
    const error = new Error(printerId ? `Printer ${printerId} was not found.` : 'No emulator printer is configured.');
    error.statusCode = 404;
    throw error;
  }
  if (printer.mode !== 'emulator') {
    const error = new Error(`${printer.name} is not configured as an emulator.`);
    error.statusCode = 409;
    throw error;
  }
  return printer;
}

app.get('/api/emulator', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canAccessDiagnostics(user)) return forbidden(res, 'You do not have permission to access diagnostics.');
    const printer = await emulatorPrinterForRequest(req);
    res.json(emulatorManager.snapshot(printer.id));
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user) && !getCapabilities(user).viewBatchReleases) return forbidden(res, 'You do not have permission to view messages.');
    const printers = await readPrinters();
    const messages = await loadMessages(undefined, { printers });
    res.json(canEditMessages(user) && req.query.enabledOnly !== 'true' ? messages : enabledMessages(messages));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/printer-agent/v1/heartbeat', async (req, res) => {
  try {
    const agent = requirePrinterAgent(req, res);
    if (!agent) return;
    const knownPrinters = await readPrinters();
    const knownPrinterIds = new Set(knownPrinters.map((printer) => printer.id));
    const knownPrinterById = new Map(knownPrinters.map((printer) => [printer.id, printer]));
    const allowedPrinterIds = new Set(agent.printerIds.includes('*') ? knownPrinterIds : agent.printerIds);
    for (const reported of Array.isArray(req.body?.statuses) ? req.body.statuses : []) {
      const printerId = String(reported?.printerId || '');
      if (!knownPrinterIds.has(printerId) || !allowedPrinterIds.has(printerId)) continue;
      if (reported.online === true && reported.rawStatus) {
        statusCache.applySuccess(printerId, {
          selectedMessage: reported.selectedMessage,
          messageVerification: reported.messageVerification,
          rawStatus: reported.rawStatus,
          protocol: printerProtocol(knownPrinterById.get(printerId) || {}),
          responseTimeMs: reported.responseTimeMs
        });
      } else {
        statusCache.applyFailure(printerId, new Error(reported.lastError || 'Printer Agent could not read printer status.'));
      }
    }
    const heartbeat = {
      agentId: agent.id,
      printerIds: agent.printerIds,
      version: String(req.body?.version || 'unknown').slice(0, 50),
      hostname: String(req.body?.hostname || '').slice(0, 120),
      seenAt: new Date().toISOString(),
      statusCount: Array.isArray(req.body?.statuses) ? req.body.statuses.length : 0
    };
    printerAgentHeartbeats.set(agent.id, heartbeat);
    res.json({ ok: true, executionMode: PRINTER_EXECUTION_MODE, serverTime: heartbeat.seenAt });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.get('/api/printer-agent/v1/config', async (req, res) => {
  try {
    const agent = requirePrinterAgent(req, res);
    if (!agent) return;
    const printers = await readPrinters();
    const allowedPrinterIds = new Set(agent.printerIds.includes('*')
      ? printers.map((printer) => printer.id)
      : agent.printerIds);
    const allowedPrinters = printers.filter((printer) => allowedPrinterIds.has(printer.id));
    res.json({
      ok: true,
      agentId: agent.id,
      printerIds: agent.printerIds,
      printers: allowedPrinters.map(printerForClient),
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.post('/api/printer-agent/v1/jobs/claim', async (req, res) => {
  try {
    const agent = requirePrinterAgent(req, res);
    if (!agent) return;
    const knownPrinterIds = (await readPrinters()).map((printer) => printer.id);
    const allowedPrinterIds = agent.printerIds.includes('*')
      ? knownPrinterIds
      : agent.printerIds.filter((printerId) => knownPrinterIds.includes(printerId));
    const job = claimPrinterAgentJob(agent.id, allowedPrinterIds);
    if (!job) return res.status(204).end();
    res.json({ ok: true, job: { id: job.id, payload: job.payload, payloadHash: job.payloadHash } });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.post('/api/printer-agent/v1/jobs/:id/complete', async (req, res) => {
  try {
    const agent = requirePrinterAgent(req, res);
    if (!agent) return;
    const current = getPrinterAgentJob(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Printer-agent job was not found.' });
    if (req.body?.payloadHash !== current.payloadHash) {
      return res.status(409).json({ ok: false, error: 'Printer-agent payload hash does not match the queued job.' });
    }
    if (['completed', 'failed'].includes(current.status) && current.claimedByAgentId === agent.id) {
      const release = current.releaseId ? getBatchRelease(current.releaseId) : null;
      return res.json({ ok: true, duplicate: true, releaseId: current.releaseId, printerId: current.printerId, status: release?.status || current.status });
    }
    const reportedResult = req.body?.result || { ok: false, error: 'Printer agent returned no result.' };
    const result = withOperatorError({
      ...reportedResult,
      reverify: current.context?.reverify === true || reportedResult.reverify === true,
      printerId: reportedResult.printerId || current.printerId,
      operationId: reportedResult.operationId || current.id,
      requestedMessage: reportedResult.requestedMessage || current.payload?.message?.printerMessageName
    });
    const job = completePrinterAgentJob(req.params.id, agent.id, result);
    const actor = job.jobType === 'manual'
      ? { id: job.context.actorUserId || null, username: job.context.actorUsername || `agent:${agent.id}`, developmentIdentity: !job.context.actorUserId }
      : { username: `agent:${agent.id}`, developmentIdentity: true };
    insertMessageUpdateEvent(result, actor);
    if (result.ok && result.expectedOutput) await persistExpectedOutput(job.printerId, result.expectedOutput);
    if (job.jobType === 'manual') {
      addLog({
        action: result.ok && result.messageMatches !== false ? 'message-update-success' : 'message-update-failure',
        ...auditActor(actor), targetType: 'printer', targetId: job.printerId, printerId: job.printerId,
        operationId: result.operationId, requestedMessage: result.requestedMessage || result.expectedOutput?.printerMessageName,
        selectedMessage: result.selectedMessage, rawStatus: result.rawStatus,
        decodedFaultCodes: result.decodedStatus?.faults?.map((fault) => fault.code) || [], fieldResults: result.fieldResults,
        error: result.technicalMessage || result.error || null,
        details: {
          reason: job.context.reason, mode: 'manual-exception', agentId: agent.id, jobId: job.id,
          operatorMessage: result.operatorMessage || null,
          technicalMessage: result.technicalMessage || result.error || null
        }
      });
      broadcast('printer-status', result);
      return res.json({ ok: true, jobId: job.id, printerId: job.printerId, status: job.status });
    }
    const { release } = await printerRuntimeService.completeAgentReleaseApply({ agent, job, result });
    broadcast('printer-status', result);
    broadcast('batch-release-execution', { releaseId: job.releaseId, printerId: job.printerId, status: release.status });
    res.json({ ok: true, releaseId: job.releaseId, printerId: job.printerId, status: release.status });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.get('/api/printer-user-fields', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit printer user fields.');
  res.json(listPrinterUserFields(req.query.printerId || null));
});

app.post('/api/printers/:printerId/user-fields', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit printer user fields.');
    const printers = await readPrinters();
    if (!printers.some((printer) => printer.id === req.params.printerId)) {
      return res.status(404).json({ ok: false, error: 'Printer was not found.' });
    }
    res.status(201).json({ ok: true, field: createPrinterUserField(req.params.printerId, req.body || {}) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.put('/api/printer-user-fields/:id', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit printer user fields.');
    const field = updatePrinterUserField(req.params.id, req.body || {});
    if (!field) return res.status(404).json({ ok: false, error: 'Printer user field was not found.' });
    res.json({ ok: true, field });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete('/api/printer-user-fields/:id', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit printer user fields.');
    const field = deletePrinterUserField(req.params.id);
    if (!field) return res.status(404).json({ ok: false, error: 'Printer user field was not found.' });
    res.json({ ok: true, field });
  } catch (error) {
    res.status(409).json({ ok: false, error: error.message });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit messages.');
    const printers = await readPrinters();
    const messages = await loadMessages(undefined, { printers });
    if (messages.some((message) => message.id === req.body?.id)) {
      return res.status(409).json({ ok: false, error: `Message ${req.body.id} already exists.` });
    }
    const input = resolveMessageUserFields(req.body || {});
    const saved = await saveMessages([...messages, input], undefined, { printers });
    await syncEmulatorManager(printers, saved);
    const message = saved.find((item) => item.id === req.body.id);
    broadcast('messages-updated', { messages: saved });
    res.status(201).json({ ok: true, message });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/api/messages/:id', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit messages.');
    const printers = await readPrinters();
    const message = getMessageById(await loadMessages(undefined, { printers }), req.params.id);
    if (!message.enabled) return res.status(404).json({ ok: false, error: `Message ${req.params.id} was not found.` });
    res.json(message);
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.put('/api/messages/:id', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit messages.');
    const printers = await readPrinters();
    const messages = await loadMessages(undefined, { printers });
    const index = messages.findIndex((message) => message.id === req.params.id);
    if (index < 0) return res.status(404).json({ ok: false, error: `Message ${req.params.id} was not found.` });

    const updated = resolveMessageUserFields({
      ...messages[index],
      ...req.body,
      id: messages[index].id
    });
    messages[index] = updated;
    const saved = await saveMessages(messages, undefined, { printers });
    await syncEmulatorManager(printers, saved);
    broadcast('messages-updated', { messages: saved });
    res.json({ ok: true, message: saved[index] });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete('/api/messages/:id', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit messages.');
    const message = deleteMessage(req.params.id);
    if (!message) return res.status(404).json({ ok: false, error: `Message ${req.params.id} was not found.` });
    const printers = await readPrinters();
    const messages = await loadMessages(undefined, { printers });
    await syncEmulatorManager(printers, messages);
    addLog({ action: 'message-deleted', ...auditActor(user), targetType: 'message', targetId: req.params.id, details: { displayName: message.displayName, ok: true } });
    broadcast('messages-updated', { messages });
    res.json({ ok: true, message });
  } catch (error) {
    res.status(409).json({ ok: false, error: error.message });
  }
});

app.post('/api/messages/:id/preview', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (req.body?.printerId && !canViewPrinter(user, req.body.printerId)) {
      return forbidden(res, 'You do not have permission to view this printer.');
    }
    if (!req.body?.printerId && !canEditMessages(user)) {
      return forbidden(res, 'You do not have permission to preview global messages.');
    }
    const printers = await readPrinters();
    const messages = await loadMessages(undefined, { printers });
    const message = req.body?.printerId
      ? getMessageForPrinter(messages, req.params.id, req.body.printerId)
      : getMessageById(messages, req.params.id);
    if (!message.enabled) return res.status(404).json({ ok: false, error: `Message ${req.params.id} was not found.` });
    res.json(renderPreview(message, req.body?.fields || {}, { productionDate: req.body?.productionDate }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

async function validateProductMasterInput(input) {
  const specification = input?.specification || {};
  const printers = await readPrinters();
  const printerMap = new Map(printers.map((printer) => [printer.id, printer]));
  const messages = await loadMessages(undefined, { printers });
  const requestedConfigurations = Array.isArray(specification.printerConfigurations) ? specification.printerConfigurations : [];
  if (!requestedConfigurations.length) throw new Error('Select at least one permitted printer.');
  if (new Set(requestedConfigurations.map((configuration) => configuration.printerId)).size !== requestedConfigurations.length) {
    throw new Error('Each printer can appear only once in a product master.');
  }
  const printerConfigurations = [];
  for (const requested of requestedConfigurations) {
    const printerId = requested.printerId;
    const printer = printerMap.get(printerId);
    if (!printer) throw new Error(`Printer ${printerId} was not found.`);
    const message = getMessageForPrinter(messages, requested.messageId, printerId);
    if (!message.enabled) throw new Error(`${message.displayName} is archived. Restore it before adding it to a product master.`);
    if (!message.previewLines.length || message.previewLines.length > 4) throw new Error(`${message.displayName} must define between one and four preview lines.`);
    const allowedSources = new Set(['run_code', 'brew_sheet_product', 'brew_number']);
    const mappings = Array.isArray(requested.fieldMappings) ? requested.fieldMappings : [];
    const mappingByKey = new Map(mappings.map((mapping) => [mapping.fieldKey, mapping.source]));
    for (const field of message.fields) {
      const source = mappingByKey.get(field.key);
      if (!allowedSources.has(source)) throw new Error(`Choose a release value source for ${printer.name} field ${field.label}.`);
    }
    printerConfigurations.push({
      printerId,
      messageId: message.id,
      fieldMappings: message.fields.map((field) => ({ fieldKey: field.key, source: mappingByKey.get(field.key) })),
      dateRule: message.dateRule,
      timeRule: message.timeRule,
      previewLines: message.previewLines
    });
  }
  const primary = printerConfigurations[0];
  return {
    ...input,
    specification: {
      ...specification,
      printerConfigurations,
      printerIds: printerConfigurations.map((configuration) => configuration.printerId),
      messageId: primary.messageId,
      fieldMappings: primary.fieldMappings,
      bestBeforeMonths: primary.dateRule.months ?? 0,
      bestBeforeDays: primary.dateRule.type === 'offset-days' ? Number(primary.dateRule.days ?? primary.dateRule.months ?? 0) : 0,
      dateRule: primary.dateRule,
      timeRule: primary.timeRule,
      previewLines: primary.previewLines,
      firstLineTemplate: primary.previewLines[0],
      secondLineTemplate: primary.previewLines[1] || ''
    }
  };
}

function visibleBatchRelease(user, release) {
  const capabilities = getCapabilities(user);
  if (!capabilities.viewBatchReleases) return null;
  if (!user.roles?.includes('operator') || capabilities.viewAllPrinters) return release;
  if (!['released', 'applying', 'awaiting_print_check', 'running', 'completed', 'failed'].includes(release.status)) return null;
  const assigned = new Set(user.printerIds || []);
  const printerIds = release.printerIds.filter((id) => assigned.has(id));
  const executionTargets = (release.executionTargets || []).filter((target) => assigned.has(target.printerId));
  return printerIds.length ? { ...release, printerIds, executionTargets } : null;
}

function auditActor(user) {
  return {
    actor: user.username,
    actorUserId: user.developmentIdentity ? null : (user.id || null)
  };
}

app.get('/api/product-masters', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const capabilities = getCapabilities(user);
  if (!capabilities.createBatchReleases && !capabilities.manageProductMasters && !canEditMessages(user)) {
    return forbidden(res, 'You do not have permission to view product masters.');
  }
  res.json(listProductMasters({ enabledOnly: req.query.enabled === 'true', packagingCategory: req.query.category || '' }));
});

app.post('/api/product-masters', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).manageProductMasters) return forbidden(res, 'You do not have permission to manage product masters.');
    const input = await validateProductMasterInput(req.body);
    const master = createProductMaster(input, user);
    addLog({ action: 'product-master-created', ...auditActor(user), targetType: 'product-master', targetId: master.id, details: { productCode: master.productCode, version: master.currentVersion, ok: true } });
    res.status(201).json({ ok: true, master });
  } catch (error) {
    res.status(error.statusCode || (error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400)).json({ ok: false, error: error.message });
  }
});

app.put('/api/product-masters/:id', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).manageProductMasters) return forbidden(res, 'You do not have permission to manage product masters.');
    const current = getProductMaster(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Product master was not found.' });
    const changeReason = String(req.body?.changeReason || '').trim();
    if (changeReason.length < 5) return res.status(400).json({ ok: false, error: 'A clear change reason is required when creating a new product master version.' });
    const input = await validateProductMasterInput({ ...req.body, specification: req.body?.specification || current.specification });
    const master = updateProductMaster(req.params.id, input, user);
    addLog({ action: 'product-master-version-created', ...auditActor(user), targetType: 'product-master', targetId: master.id, details: { productCode: master.productCode, version: master.currentVersion, previousVersion: current.currentVersion, reason: changeReason.slice(0, 500), ok: true } });
    res.json({ ok: true, master });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.get('/api/batch-releases', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).viewBatchReleases) return forbidden(res, 'You do not have permission to view batch releases.');
    const statuses = String(req.query.status || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (req.query.paged === 'true') {
      const capabilities = getCapabilities(user);
      const printerIds = capabilities.viewAllPrinters || user.printerIds?.includes('*') ? [] : (user.printerIds || []);
      const page = listBatchReleasesPage({
        limit: req.query.limit, offset: req.query.offset, statuses, search: req.query.search,
        printerIds, packagingCategory: req.query.category || ''
      });
      return res.json({ ...page, items: page.items.map((release) => visibleBatchRelease(user, release)).filter(Boolean) });
    }
    const releases = listBatchReleases({ limit: req.query.limit, statuses })
      .map((release) => visibleBatchRelease(user, release)).filter(Boolean);
    res.json(releases);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/batch-releases', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).createBatchReleases) return forbidden(res, 'You do not have permission to create batch releases.');
    const release = createBatchRelease(req.body || {}, user);
    addLog({ action: 'batch-release-created', ...auditActor(user), targetType: 'batch-release', targetId: release.id, details: { productMasterId: release.productMasterId, brewSheetProduct: release.brewSheetProduct, status: release.status, ok: true } });
    broadcast('batch-release-changed', { releaseId: release.id, status: release.status, action: 'created' });
    res.status(201).json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.put('/api/batch-releases/:id', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).createBatchReleases) return forbidden(res, 'You do not have permission to edit batch releases.');
    const before = getBatchRelease(req.params.id);
    if (!before) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    const release = updateBatchRelease(req.params.id, req.body || {}, user);
    addLog({
      action: 'batch-release-updated', ...auditActor(user), targetType: 'batch-release', targetId: release.id,
      details: {
        previousStatus: before.status,
        status: release.status,
        brewSheetProduct: release.brewSheetProduct,
        brewNumber: release.brewNumber,
        plannedProductionAt: release.plannedProductionAt,
        printerIds: release.printerIds,
        ok: true
      }
    });
    broadcast('batch-release-changed', { releaseId: release.id, status: release.status, action: 'updated' });
    res.json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.get('/api/batch-releases/:id/audit', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).viewBatchReleases) return forbidden(res, 'You do not have permission to view batch releases.');
    const release = visibleBatchRelease(user, getBatchRelease(req.params.id));
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    res.json(listAuditEvents({ targetType: 'batch-release', targetId: release.id, limit: req.query.limit || 100 }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/batch-releases/:id/review-claim', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).reviewBatchReleases) return forbidden(res, 'You do not have permission to review batch releases.');
    const existingClaim = getBatchRelease(req.params.id)?.reviewClaim;
    const release = claimBatchReleaseReview(req.params.id, user);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    broadcast('batch-release-presence', { releaseId: release.id, reviewClaim: release.reviewClaim });
    if (!existingClaim) addLog({ action: 'batch-release-review-claimed', ...auditActor(user), targetType: 'batch-release', targetId: release.id, details: { expiresAt: release.reviewClaim?.expiresAt, ok: true } });
    res.json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message, reviewClaim: error.reviewClaim || null });
  }
});

app.delete('/api/batch-releases/:id/review-claim', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).reviewBatchReleases) return forbidden(res, 'You do not have permission to review batch releases.');
    const release = releaseBatchReleaseReview(req.params.id, user);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    broadcast('batch-release-presence', { releaseId: release.id, reviewClaim: release.reviewClaim });
    res.json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.post('/api/batch-releases/:id/submit', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).createBatchReleases) return forbidden(res, 'You do not have permission to submit batch releases.');
    const release = submitBatchRelease(req.params.id, user);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    addLog({ action: 'batch-release-submitted', ...auditActor(user), targetType: 'batch-release', targetId: release.id, details: { status: release.status, ok: true } });
    broadcast('batch-release-changed', { releaseId: release.id, status: release.status, action: 'submitted' });
    res.json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.post('/api/batch-releases/:id/approve', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).reviewBatchReleases) return forbidden(res, 'You do not have permission to approve batch releases.');
    const release = approveBatchRelease(req.params.id, user);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    addLog({ action: 'batch-release-approved', ...auditActor(user), targetType: 'batch-release', targetId: release.id, details: { status: release.status, runCode: release.runCode, ok: true } });
    broadcast('batch-release-presence', { releaseId: release.id, reviewClaim: null, status: release.status });
    broadcast('batch-release-changed', { releaseId: release.id, status: release.status, action: 'approved' });
    res.json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.post('/api/batch-releases/:id/reject', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).reviewBatchReleases) return forbidden(res, 'You do not have permission to review batch releases.');
    const release = rejectBatchRelease(req.params.id, req.body?.reason, user);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    addLog({ action: 'batch-release-rejected', ...auditActor(user), targetType: 'batch-release', targetId: release.id, details: { status: release.status, reason: release.rejectionReason, ok: true } });
    broadcast('batch-release-presence', { releaseId: release.id, reviewClaim: null, status: release.status });
    broadcast('batch-release-changed', { releaseId: release.id, status: release.status, action: 'rejected' });
    res.json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.post('/api/batch-releases/:id/targets/:printerId/apply', async (req, res) => {
  let began = false;
  let user;
  try {
    user = requireUser(req, res);
    if (!user) return;
    let release = getBatchRelease(req.params.id);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    const { printer } = await releaseExecutionService.executionContext(release, req.params.printerId, user);
    if (PRINTER_EXECUTION_MODE === 'local' && stateChangingOperations.has(printer.id)) {
      const error = new Error('A message update is already in progress on this printer.');
      error.statusCode = 409;
      throw error;
    }
    const reverify = req.body?.reverify === true;
    const prepared = await releaseExecutionService.prepareApply({
      release,
      printerId: req.params.printerId,
      user,
      reapply: req.body?.reapply === true,
      reverify,
      reason: req.body?.reason
    });
    release = prepared.release;
    const execution = prepared.execution;
    if (prepared.assigningRun) releaseAudit.runAssigned(user, release, printer);
    began = true;
    if (PRINTER_EXECUTION_MODE === 'local') stateChangingOperations.add(printer.id);
    releaseAudit.applicationStarted(user, release, printer, { reapply: req.body?.reapply === true, reverify, reason: req.body?.reason });
    broadcast('batch-release-execution', { releaseId: release.id, printerId: printer.id, status: 'applying' });

    if (PRINTER_EXECUTION_MODE === 'agent') {
      const job = enqueuePrinterAgentJob({
        releaseId: release.id,
        printerId: printer.id,
        payload: {
          protocolVersion: 1,
          releaseId: release.id,
          printerId: printer.id,
          plannedProductionAt: release.plannedProductionAt,
          message: printerAgentMessage(execution.message),
          fields: execution.expectedOutput.fields || {},
          expectedRendered: execution.expectedOutput.rendered,
          reverify
        },
        context: { reverify }
      });
      releaseAudit.agentJobQueued(user, release, printer, job);
      return res.status(202).json({
        ok: true,
        queued: true,
        job: { id: job.id, payloadHash: job.payloadHash },
        release: visibleBatchRelease(user, getBatchRelease(release.id))
      });
    }

    const { result, release: updated } = await printerRuntimeService.applyReleaseLocally({
      release,
      printer,
      execution,
      user,
      reverify
    });
    broadcast('printer-status', result);
    broadcast('batch-release-execution', { releaseId: release.id, printerId: printer.id, status: updated.status });
    res.status(result.ok && result.messageMatches !== false ? 200 : 409).json({ ok: result.ok && result.messageMatches !== false, release: visibleBatchRelease(user, updated), result });
  } catch (error) {
    const failure = withOperatorError(error instanceof MessageUpdateError && error.result
      ? { ...error.result, ok: false, error: error.result.error || error.message, checkedAt: new Date().toISOString() }
      : { ok: false, code: error.code || null, printerId: req.params.printerId, error: error.message, checkedAt: new Date().toISOString() });
    if (began) {
      const { release: updated } = printerRuntimeService.markApplyFailed({
        releaseId: req.params.id,
        printerId: req.params.printerId,
        failure,
        user
      });
      broadcast('batch-release-execution', { releaseId: req.params.id, printerId: req.params.printerId, status: updated.status });
    }
    res.status(error.statusCode || (began ? 502 : 409)).json({ ...failure, release: began && user ? visibleBatchRelease(user, getBatchRelease(req.params.id)) : undefined });
  } finally {
    stateChangingOperations.delete(req.params.printerId);
  }
});

app.post('/api/batch-releases/:id/targets/:printerId/print-check', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const passed = req.body?.passed === true;
    const checked = releaseExecutionService.verifyPrintCheck({
      releaseId: req.params.id,
      printerId: req.params.printerId,
      passed,
      reason: req.body?.reason,
      user
    });
    if (!checked) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    const { release, reverify } = checked;
    releaseAudit.printChecked(user, release, req.params.printerId, { passed, reason: req.body?.reason, reverify });
    if (passed) releaseAudit.productionRunning(user, release, req.params.printerId, { reverify });
    broadcast('batch-release-execution', { releaseId: release.id, printerId: req.params.printerId, status: release.status });
    res.json({ ok: true, release: visibleBatchRelease(user, release) });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.delete('/api/batch-releases/:id', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getCapabilities(user).createBatchReleases) return forbidden(res, 'You do not have permission to delete draft releases.');
    if (!deleteDraftBatchRelease(req.params.id)) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    broadcast('batch-release-changed', { releaseId: req.params.id, action: 'deleted' });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.post('/api/batch-releases/:id/targets/:printerId/end-run', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const release = releaseExecutionService.endRun({ releaseId: req.params.id, printerId: req.params.printerId, user });
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    releaseAudit.runEnded(user, release, req.params.printerId);
    broadcast('batch-release-execution', { releaseId: release.id, printerId: req.params.printerId, status: release.status });
    res.json({ ok: true, release: visibleBatchRelease(user, release) });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.post('/api/batch-releases/:id/return-for-review', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const current = getBatchRelease(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    const assignedOperator = current.printerIds.some((printerId) => canOperatePrinter(user, printerId));
    if (!assignedOperator && !getCapabilities(user).reviewBatchReleases && !getCapabilities(user).createBatchReleases) return forbidden(res, 'You do not have permission to return this release for review.');
    const release = returnBatchReleaseForReview(req.params.id, req.body?.reason, user);
    releaseAudit.returnedForReview(user, release);
    broadcast('batch-release-execution', { releaseId: release.id, status: release.status });
    broadcast('batch-release-changed', { releaseId: release.id, status: release.status, action: 'returned-for-review' });
    res.json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

app.get('/api/debug/wsi-counters', (req, res) => {
  if (!ENABLE_TEST_ENDPOINTS) return res.status(404).json({ ok: false, error: 'Not found.' });
  const user = requireUser(req, res);
  if (!user) return;
  if (!canAccessDiagnostics(user)) return forbidden(res, 'You do not have permission to access diagnostics.');
  res.json(wsiClient.getCounters());
});

app.post('/api/debug/wsi-counters/reset', (req, res) => {
  if (!ENABLE_TEST_ENDPOINTS) return res.status(404).json({ ok: false, error: 'Not found.' });
  const user = requireUser(req, res);
  if (!user) return;
  if (!canAccessDiagnostics(user)) return forbidden(res, 'You do not have permission to access diagnostics.');
  wsiClient.resetCounters();
  res.json({ ok: true });
});

app.get('/api/events', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const client = { response: res, user };
  eventClients.add(client);
  req.on('close', () => eventClients.delete(client));
  sendEvent(res, 'connected', { connected: true });
  if (canViewAudit(user) || canAccessDiagnostics(user)) sendEvent(res, 'logs-snapshot', commandLog);
  try {
    const printers = await readPrinters();
    const firstEmulator = printers.find((printer) => printer.mode === 'emulator');
    if (canAccessDiagnostics(user) && firstEmulator) sendEvent(res, 'emulator-snapshot', emulatorManager.snapshot(firstEmulator.id));
    syncStatusPrinters(printers);
    sendEvent(res, 'status-snapshot', statusCache.all().filter((status) => canViewPrinter(user, status.printerId)));
    sendEvent(res, 'fleet-snapshot', visiblePrinters(user, printers).map(printerForClient));
  } catch (error) {
    if (canAccessDiagnostics(user)) sendEvent(res, 'stream-error', { error: error.message });
  }
});

app.get('/api/printers', async (_req, res) => {
  try {
    const user = requireUser(_req, res);
    if (!user) return;
    const printers = await readPrinters();
    syncStatusPrinters(printers);
    const enabledOnly = _req.query.enabledOnly === 'true';
    res.json(visiblePrinters(user, printers)
      .filter((printer) => !enabledOnly || printer.enabled)
      .map(printerForClient));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/printers', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canConfigurePrinters(user)) return forbidden(res, 'You do not have permission to configure printers.');
    const printer = await createPrinter(req.body || {});
    const printers = await readPrinters();
    await syncEmulatorManager(printers);
    syncStatusPrinters(printers);
    const clientPrinter = printerForClient(printer);
    addLog({ action: 'printer-created', actor: user.username, printerId: printer.id, ok: true });
    broadcast('fleet-snapshot', printers);
    res.status(201).json({ ok: true, printer: clientPrinter });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/api/printers/status', async (_req, res) => {
  try {
    const user = requireUser(_req, res);
    if (!user) return;
    const printers = await readPrinters();
    syncStatusPrinters(printers);
    const enabledOnly = _req.query.enabledOnly === 'true';
    const visibleIds = new Set(visiblePrinters(user, printers)
      .filter((printer) => !enabledOnly || printer.enabled)
      .map((printer) => printer.id));
    res.json(statusCache.all().filter((status) => visibleIds.has(status.printerId)));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/printer/current-message', async (req, res) => {
  let printer = null;
  let target = null;
  const checkedAt = () => new Date().toISOString();

  try {
    const user = requireUser(req, res);
    if (!user) return;
    const printers = await readPrinters();
    const visible = visiblePrinters(user, printers);
    printer = req.query.printerId
      ? printers.find((item) => item.id === req.query.printerId)
      : visible.find((item) => item.enabled) || visible[0];

    if (!printer) {
      return res.status(404).json({ ok: false, printer: null, error: 'No accessible printer was found.', rawCode: null, checkedAt: checkedAt() });
    }
    if (!canViewPrinter(user, printer.id)) return forbidden(res, 'You do not have permission to view this printer.');

    target = printerTarget(printer);
    const capabilities = runtimePrinterCapabilities(printer);
    const address = `${target.ip}:${target.port}`;
    addLog({
      action: 'current-message-request-start',
      printerId: printer.id,
      targetHost: target.ip,
      targetPort: target.port,
      mode: printer.mode,
      ok: true
    });

    if (!printer.enabled) {
      const error = new Error(`${printer.name} is disabled.`);
      error.statusCode = 409;
      throw error;
    }
    if (capabilities.currentMessageReadbackMode === 'disabled') {
      const error = new Error(`Current-message readback is disabled for ${printer.name}.`);
      error.statusCode = 409;
      error.reasonCode = 'CURRENT_MESSAGE_READBACK_UNSUPPORTED';
      throw error;
    }

    const readback = await coderQueue.run(
      printer.id,
      { operation: 'current-message-readback' },
      () => readCurrentMessageForPrinter(printer, target, { force: true })
    );
    const result = { ok: true, printer: address, ...readback, checkedAt: checkedAt() };
    addLog({
      action: 'current-message-request-success',
      printerId: printer.id,
      targetHost: target.ip,
      targetPort: target.port,
      currentMessage: result.currentMessage,
      rawCode: result.rawCode,
      rawResponseHex: result.rawResponseHex,
      ok: true
    });
    res.json(result);
  } catch (error) {
    const address = target ? `${target.ip}:${target.port}` : null;
    const result = {
      ok: false,
      printer: address,
      error: error.message || 'Current-message readback failed.',
      rawCode: error.rawCode || null,
      checkedAt: checkedAt()
    };
    if (error.reasonCode) result.reasonCode = error.reasonCode;
    if (error.command) result.command = error.command;
    if (error.commandName) result.commandName = error.commandName;
    if (error.responseChecksum) result.responseChecksum = error.responseChecksum;
    if (error.expectedChecksum) result.expectedChecksum = error.expectedChecksum;
    if (typeof error.checksumMatches === 'boolean') result.checksumMatches = error.checksumMatches;
    if (error.rawResponseHex) result.rawResponseHex = error.rawResponseHex;
    addLog({
      action: 'current-message-request-failure',
      printerId: printer?.id || null,
      targetHost: target?.ip || null,
      targetPort: target?.port || null,
      error: result.error,
      rawCode: result.rawCode,
      rawResponseHex: result.rawResponseHex || null,
      ok: false
    });
    res.status(error.statusCode || 502).json(result);
  }
});

app.get('/api/faults', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canViewFaultHistory(user)) return forbidden(res, 'You do not have permission to view fault history.');
    const result = faultHistory.query(parseFaultQuery(req.query));
    res.json({
      activeFaults: result.activeFaults.filter((fault) => canViewPrinter(user, fault.printerId)),
      history: result.history.filter((event) => canViewPrinter(user, event.printerId))
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.get('/api/printers/:printerId/faults', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canViewFaultHistory(user)) return forbidden(res, 'You do not have permission to view fault history.');
    const printers = await readPrinters();
    if (!printers.some((printer) => printer.id === req.params.printerId)) {
      return res.status(404).json({ ok: false, error: `Printer ${req.params.printerId} was not found.` });
    }
    if (!canViewPrinter(user, req.params.printerId)) return forbidden(res, 'You do not have permission to view this printer.');
    res.json(faultHistory.query({ printerId: req.params.printerId, ...parseFaultQuery(req.query) }));
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.get('/api/printers/:printerId/messages', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const printers = await readPrinters();
    const printer = printers.find((item) => item.id === req.params.printerId);
    if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.params.printerId} was not found.` });
    if (!canViewPrinter(user, printer.id)) return forbidden(res, 'You do not have permission to view this printer.');
    if (!canOperatePrinter(user, printer.id)) return forbidden(res, 'You do not have permission to operate this printer.');
    res.json(messagesForPrinter(await loadMessages(undefined, { printers }), printer.id));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/printers/:id', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const printers = await readPrinters();
    syncStatusPrinters(printers);
    const printer = printers.find((item) => item.id === req.params.id);
    if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.params.id} was not found.` });
    if (!canViewPrinter(user, printer.id)) return forbidden(res, 'You do not have permission to view this printer.');
    res.json(printerForClient(printer));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/printers/:id/status', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const printers = await readPrinters();
    syncStatusPrinters(printers);
    const printer = printers.find((item) => item.id === req.params.id);
    if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.params.id} was not found.` });
    if (!canViewPrinter(user, printer.id)) return forbidden(res, 'You do not have permission to view this printer.');
    res.json(statusCache.get(req.params.id));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put('/api/printers/:id', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canConfigurePrinters(user)) return forbidden(res, 'You do not have permission to configure printers.');
    const printers = await updatePrinter(req.params.id, req.body || {});
    await syncEmulatorManager(printers);
    syncStatusPrinters(printers);
    const printer = printers.find((item) => item.id === req.params.id);
    readbackCapabilities.clear(req.params.id);
    const clientPrinter = printerForClient(printer);
    broadcast('printer-config', clientPrinter);
    broadcast('status-snapshot', statusCache.all());
    res.json({ ok: true, printer: clientPrinter });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/printers/:id/check', async (req, res) => {
  const startedAt = Date.now();
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const printers = await readPrinters();
    const printer = printers.find((item) => item.id === req.params.id);

    if (!printer) {
      return res.status(404).json({ ok: false, error: `Printer ${req.params.id} was not found.` });
    }
    if (!printer.enabled) {
      return res.status(409).json({ ok: false, error: `${printer.name} is disabled.` });
    }
    if (!canOperatePrinter(user, printer.id)) return forbidden(res, 'You do not have permission to operate this printer.');

    const result = await refreshPrinterStatus(printer, 'check');
    addLog({ action: 'printer-check', printerId: printer.id, operationId: result.operationId, ok: true, ...result });
    broadcast('printer-status', { ok: true, ...result });
    res.json({ ok: true, ...result });
  } catch (error) {
    const cached = statusCache.get(req.params.id);
    const result = {
      ok: false,
      printerId: req.params.id,
      ...cached,
      error: error.message,
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt
    };
    addLog({
      action: 'printer-check',
      printerId: req.params.id,
      ok: false,
      error: error.message,
      elapsedMs: Date.now() - startedAt
    });
    broadcast('printer-status', cached);
    res.status(502).json(result);
  }
});

app.delete('/api/printers/:id', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canConfigurePrinters(user)) return forbidden(res, 'You do not have permission to configure printers.');
    const printer = await deletePrinter(req.params.id);
    const printers = await readPrinters();
    await syncEmulatorManager(printers);
    syncStatusPrinters(printers);
    readbackCapabilities.clear(req.params.id);
    addLog({ action: 'printer-archived', actor: user.username, printerId: req.params.id, ok: true });
    broadcast('fleet-snapshot', printers);
    broadcast('status-snapshot', statusCache.all());
    res.json({ ok: true, printer: printerForClient(printer) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/printers/:id/set', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const privilegedManualSet = user.roles?.some((role) => ['qa', 'engineering', 'admin'].includes(role));
    if (user.roles?.includes('operator') && !privilegedManualSet) {
      return forbidden(res, 'Operators must use an approved production release to change a printer message.');
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) {
      return res.status(400).json({ ok: false, error: 'A clear reason is required for a manual message change.' });
    }
    if (reason.length > 500) {
      return res.status(400).json({ ok: false, error: 'The manual message reason must be 500 characters or fewer.' });
    }
    const printers = await readPrinters();
    syncStatusPrinters(printers);
    const printer = printers.find((item) => item.id === req.params.id);

    if (!printer) {
      return res.status(404).json({ ok: false, error: `Printer ${req.params.id} was not found.` });
    }
    if (!printer.enabled) {
      return res.status(409).json({ ok: false, error: `${printer.name} is disabled.` });
    }
    if (!canOperatePrinter(user, printer.id)) return forbidden(res, 'You do not have permission to operate this printer.');
    if (!statusCache.hasRevision(printer.id, req.body?.expectedRevision)) {
      const latest = statusCache.get(printer.id);
      addLog({ action: 'revision-conflict', ...auditActor(user), targetType: 'printer', targetId: printer.id, printerId: printer.id, ok: false, expectedRevision: req.body?.expectedRevision, currentRevision: latest.revision, details: { reason, mode: 'manual-exception' } });
      return res.status(409).json({ ok: false, code: 'REVISION_CONFLICT', error: 'Coder status changed before this update was submitted.', status: latest });
    }
    if (stateChangingOperations.has(printer.id)) {
      const active = coderQueue.getActive(printer.id);
      const latest = statusCache.get(printer.id);
      addLog({ action: 'busy-rejected', ...auditActor(user), targetType: 'printer', targetId: printer.id, printerId: printer.id, ok: false, operationId: active?.operationId || latest.currentOperationId, details: { reason, mode: 'manual-exception' } });
      return res.status(409).json({
        ok: false,
        code: 'CODER_BUSY',
        error: 'A message update is already in progress.',
        currentOperation: active?.operation || latest.currentOperation,
        operationId: active?.operationId || latest.currentOperationId,
        status: latest
      });
    }

    if (PRINTER_EXECUTION_MODE === 'agent') {
      const { message, fields } = await resolvePrinterMessageRequest(printer, req.body || {});
      const productionDate = req.body?.productionDate || new Date().toISOString();
      const expected = renderPreview(message, fields, { productionDate });
      const job = enqueuePrinterAgentJob({
        jobType: 'manual',
        printerId: printer.id,
        context: { reason, actorUserId: user.developmentIdentity ? null : user.id, actorUsername: user.username },
        payload: {
          protocolVersion: 1,
          printerId: printer.id,
          plannedProductionAt: productionDate,
          message: printerAgentMessage(message),
          fields,
          expectedRendered: expected.rendered
        }
      });
      addLog({
        action: 'message-update-agent-job-queued', ...auditActor(user), targetType: 'printer', targetId: printer.id,
        printerId: printer.id, requestedMessage: message.printerMessageName,
        details: { reason, mode: 'manual-exception', jobId: job.id, payloadHash: job.payloadHash, ok: true }
      });
      return res.status(202).json({
        ok: true, queued: true, job: { id: job.id, payloadHash: job.payloadHash },
        printerId: printer.id, requestedMessage: message.printerMessageName
      });
    }

    stateChangingOperations.add(printer.id);
    addLog({ action: 'message-update-start', ...auditActor(user), targetType: 'printer', targetId: printer.id, printerId: printer.id, ok: true, requestedMessage: req.body?.messageId || req.body?.messageName, details: { reason, mode: 'manual-exception' } });
    const result = await setPrinterMessage(printer, req.body || {});
    insertMessageUpdateEvent(result, user);
    if (result.ok && result.expectedOutput) await persistExpectedOutput(printer.id, result.expectedOutput);
    addLog({ action: result.messageMatches === false ? 'message-update-mismatch' : 'message-update-success', ...auditActor(user), targetType: 'printer', targetId: printer.id, printerId: printer.id, operationId: result.operationId, requestedMessage: result.requestedMessage || result.expectedMessage, selectedMessage: result.selectedMessage, rawStatus: result.rawStatus, decodedFaultCodes: result.decodedStatus?.faults?.map((fault) => fault.code) || [], fieldResults: result.fieldResults, details: { reason, mode: 'manual-exception' }, ...result });
    broadcast('printer-status', result);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    if (error instanceof MessageUpdateError && error.result) {
      const result = withOperatorError({ ...error.result, checkedAt: new Date().toISOString() });
      insertMessageUpdateEvent(result, currentUser(req) || {});
      addLog({
        action: 'message-update-failure', ...auditActor(currentUser(req) || {}), targetType: 'printer',
        targetId: req.params.id, printerId: req.params.id, ok: false,
        error: result.technicalMessage || error.message,
        fieldResults: result.fieldResults, messageSelection: result.messageSelection,
        details: {
          reason: String(req.body?.reason || '').trim(), mode: 'manual-exception',
          operatorMessage: result.operatorMessage || null,
          technicalMessage: result.technicalMessage || error.message
        }
      });
      return res.status(502).json(result);
    }
    if (error.statusCode === 400) {
      addLog({ action: 'message-update-rejected', ...auditActor(currentUser(req) || {}), targetType: 'printer', targetId: req.params.id, printerId: req.params.id, ok: false, error: error.message, details: { reason: String(req.body?.reason || '').trim(), mode: 'manual-exception' } });
      return res.status(400).json({ ok: false, error: error.message });
    }

    const cached = statusCache.get(req.params.id);
    const result = {
      ok: false,
      printerId: req.params.id,
      ...cached,
      error: error.message,
      checkedAt: new Date().toISOString()
    };
    const enriched = withOperatorError(result);
    addLog({
      action: 'message-update-failure', ...auditActor(currentUser(req) || {}), targetType: 'printer',
      targetId: req.params.id, printerId: req.params.id, ok: false, error: enriched.technicalMessage || error.message,
      details: {
        reason: String(req.body?.reason || '').trim(), mode: 'manual-exception',
        operatorMessage: enriched.operatorMessage || null,
        technicalMessage: enriched.technicalMessage || error.message
      }
    });
    broadcast('printer-status', cached);
    res.status(502).json(enriched);
  } finally {
    stateChangingOperations.delete(req.params.id);
  }
});

app.post('/api/printers/check-all', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const printers = (await readPrinters()).filter((printer) => printer.enabled && canOperatePrinter(user, printer.id));
  const results = [];

  for (const printer of printers) {
    try {
      const result = await refreshPrinterStatus(printer, 'check');
      results.push({ ok: true, ...result });
      addLog({ action: 'printer-check', printerId: printer.id, operationId: result.operationId, ok: true, ...result });
      broadcast('printer-status', { ok: true, ...result });
    } catch (error) {
      const cached = statusCache.get(printer.id);
      const result = {
        ok: false,
        id: printer.id,
        printerId: printer.id,
        name: printer.name,
        location: printer.location,
        host: printer.host,
        port: printer.port,
        mode: printer.mode,
        enabled: printer.enabled,
        ...cached,
        error: error.message,
        checkedAt: new Date().toISOString()
      };
      results.push(result);
      addLog({ action: 'printer-check', printerId: printer.id, ...result });
      broadcast('printer-status', cached);
    }
  }

  res.json({ ok: results.every((result) => result.ok), results });
});

app.post('/api/emulator', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canAccessDiagnostics(user)) return forbidden(res, 'You do not have permission to access diagnostics.');
    const printer = await emulatorPrinterForRequest(req);
    const snapshot = emulatorManager.update(printer.id, req.body || {});
    broadcast('emulator-snapshot', snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.post('/api/emulator/reset', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canAccessDiagnostics(user)) return forbidden(res, 'You do not have permission to access diagnostics.');
    const printer = await emulatorPrinterForRequest(req);
    const snapshot = emulatorManager.reset(printer.id);
    broadcast('emulator-snapshot', snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.post('/api/check', async (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (req.body?.printerId) {
      const printers = await readPrinters();
      syncStatusPrinters(printers);
      const printer = printers.find((item) => item.id === req.body.printerId);
      if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.body.printerId} was not found.` });
      if (!canOperatePrinter(user, printer.id)) return forbidden(res, 'You do not have permission to operate this printer.');
      const result = await refreshPrinterStatus(printer, 'check');
      addLog({ action: 'check', printerId: printer.id, operationId: result.operationId, ok: true, ...result });
      return res.json({ ok: true, ...result });
    }
    if (!ENABLE_UNSAFE_DEVELOPMENT_TOOLS) {
      return res.status(403).json({ ok: false, error: 'Arbitrary printer targets are disabled. Use printerId.' });
    }
    if (!canAccessDiagnostics(user)) return forbidden(res, 'You do not have permission to access diagnostics.');

    const { ip, port } = printerConfig(req.body);
    const { message, status } = await coderQueue.run(`unsafe:${ip}:${port}`, { operation: 'unsafe-check' }, async () => {
      const message = assertPacketResponse('Q', await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: 'Q' }));
      await delay(BETWEEN_COMMAND_DELAY_MS);
      const status = assertPacketResponse('E', await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: 'E' }));
      return { message, status };
    });
    addLog({ action: 'check', ip, port, ok: true, message: message.value, status: status.value });
    res.json({ ok: true, selectedMessage: message.value, status: status.value, raw: { message, status } });
  } catch (error) {
    addLog({ action: 'check', ok: false, error: error.message });
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.post('/api/set', async (req, res) => {
  const startedAt = Date.now();
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (req.body?.printerId) {
      const printers = await readPrinters();
      syncStatusPrinters(printers);
      const printer = printers.find((item) => item.id === req.body.printerId);
      if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.body.printerId} was not found.` });
      if (!printer.enabled) return res.status(409).json({ ok: false, error: `${printer.name} is disabled.` });
      if (!canOperatePrinter(user, printer.id)) return forbidden(res, 'You do not have permission to operate this printer.');
      if (!statusCache.hasRevision(printer.id, req.body?.expectedRevision)) {
        const latest = statusCache.get(printer.id);
        addLog({ action: 'revision-conflict', printerId: printer.id, ok: false, expectedRevision: req.body?.expectedRevision, currentRevision: latest.revision });
        return res.status(409).json({ ok: false, code: 'REVISION_CONFLICT', error: 'Coder status changed before this update was submitted.', status: latest });
      }
      if (stateChangingOperations.has(printer.id)) {
        const active = coderQueue.getActive(printer.id);
        const latest = statusCache.get(printer.id);
        addLog({ action: 'busy-rejected', printerId: printer.id, ok: false, operationId: active?.operationId || latest.currentOperationId });
        return res.status(409).json({
          ok: false,
          code: 'CODER_BUSY',
          error: 'A message update is already in progress.',
          currentOperation: active?.operation || latest.currentOperation,
          operationId: active?.operationId || latest.currentOperationId,
          status: latest
        });
      }
      stateChangingOperations.add(printer.id);
      try {
        const result = await setPrinterMessage(printer, req.body || {});
        insertMessageUpdateEvent(result, user);
        if (result.ok && result.expectedOutput) await persistExpectedOutput(printer.id, result.expectedOutput);
        addLog({ action: result.messageMatches === false ? 'message-update-mismatch' : 'message-update-success', printerId: printer.id, operationId: result.operationId, ...result });
        return res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        if (error instanceof MessageUpdateError && error.result) {
          const result = withOperatorError({ ...error.result, checkedAt: new Date().toISOString() });
          insertMessageUpdateEvent(result, user);
          addLog({
            action: 'message-update-failure', printerId: printer.id, ok: false,
            error: result.technicalMessage || error.message,
            fieldResults: result.fieldResults,
            messageSelection: result.messageSelection,
            details: {
              operatorMessage: result.operatorMessage || null,
              technicalMessage: result.technicalMessage || error.message
            }
          });
          return res.status(502).json(result);
        }
        if (error.statusCode === 400) {
          addLog({ action: 'message-update-rejected', printerId: printer.id, ok: false, error: error.message });
          return res.status(400).json({ ok: false, error: error.message });
        }
        throw error;
      } finally {
        stateChangingOperations.delete(printer.id);
      }
    }
    if (!ENABLE_UNSAFE_DEVELOPMENT_TOOLS) {
      return res.status(403).json({ ok: false, error: 'Arbitrary printer targets are disabled. Use printerId.' });
    }
    if (!canAccessDiagnostics(user)) return forbidden(res, 'You do not have permission to access diagnostics.');

    const { ip, port } = printerConfig(req.body);
    const { messageName, fieldName, fieldValue } = req.body;
    validateAscii(messageName, 'Message name', 30);
    validateAscii(fieldName, 'User field name', 30);
    validateAscii(fieldValue, 'User field value', 50);

    const { update, select, selected, status } = await coderQueue.run(`unsafe:${ip}:${port}`, { operation: 'unsafe-set' }, async () => {
      const update = await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: `U${fieldName}\n${fieldValue}` });
      if (update.kind !== 'ack') throw new Error(failureMessage(`U${fieldName}\n${fieldValue}`, update));
      await delay(BETWEEN_COMMAND_DELAY_MS);

      const select = await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: `M${messageName}` });
      if (select.kind !== 'ack') throw new Error(failureMessage(`M${messageName}`, select));
      await delay(BETWEEN_COMMAND_DELAY_MS);

      const selected = assertPacketResponse('Q', await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: 'Q' }));
      await delay(BETWEEN_COMMAND_DELAY_MS);
      const status = assertPacketResponse('E', await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: 'E' }));
      return { update, select, selected, status };
    });
    const messageMatches = selected.value === messageName;

    const result = {
      ok: messageMatches,
      messageMatches,
      expectedMessage: messageName,
      selectedMessage: selected.value,
      fieldName,
      fieldValue,
      status: status.value,
      acknowledgements: { update: update.value, select: select.value },
      elapsedMs: Date.now() - startedAt
    };
    addLog({ action: 'set', ip, port, ...result });
    res.status(messageMatches ? 200 : 409).json(result);
  } catch (error) {
    addLog({ action: 'set', ok: false, error: error.message, elapsedMs: Date.now() - startedAt });
    res.status(502).json({ ok: false, error: error.message });
  }
});

const monitor = new Monitor({
  readPrinters: async () => {
    const printers = await readPrinters();
    await syncEmulatorManager(printers);
    syncStatusPrinters(printers);
    return printers;
  },
  pollPrinter: async (printer) => {
    await refreshPrinterStatus(printer, 'poll');
  },
  pollIntervalMs: POLL_INTERVAL_MS,
  betweenCoderDelayMs: BETWEEN_CODER_DELAY_MS,
  delay,
  onError: (error) => broadcast('stream-error', { error: error.message })
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Videojet control running on http://localhost:${PORT}`);
  console.log(`Default printer: ${DEFAULT_PRINTER_IP}:${DEFAULT_PRINTER_PORT}`);
  if (PRINTER_EXECUTION_MODE === 'local' && POLL_INTERVAL_MS > 0) {
    monitor.start();
    setInterval(() => broadcast('heartbeat', { time: new Date().toISOString() }), SSE_HEARTBEAT_MS);
    console.log(`Server-side monitoring every ${POLL_INTERVAL_MS} ms`);
  }
});

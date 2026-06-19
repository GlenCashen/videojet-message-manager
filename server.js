import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrinter, deletePrinter, readPrinters, updatePrinter } from './printer-store.js';
import { createSessionManager } from './server/auth.js';
import { CoderQueue } from './server/coder-queue.js';
import { requestCurrentMessage } from './server/current-message.js';
import { EmulatorManager } from './server/emulator-manager.js';
import { ReadbackCapabilityRegistry } from './server/readback-capability-registry.js';
import { databaseStatus } from './server/db.js';
import { importJsonToSqlite } from './server/migrate-json-to-sqlite.js';
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
import {
  createMessageJob,
  getMessageJob,
  listMessageJobs,
  updateMessageJobTarget
} from './server/repositories/message-job-repository.js';
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
  finishBatchReleaseTarget,
  getBatchRelease,
  listBatchReleases,
  recoverInterruptedBatchReleaseTargets,
  rejectBatchRelease,
  releaseBatchReleaseReview,
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
const FAULT_HISTORY_LIMIT = Number(process.env.FAULT_HISTORY_LIMIT || 1000);
const FAULT_HISTORY_PATH = process.env.FAULT_HISTORY_PATH || undefined;
const FAULT_HISTORY_API_MAX_LIMIT = 500;
const auth = createSessionManager({
  secret: SESSION_SECRET || undefined,
  secure: process.env.NODE_ENV === 'production'
});
await importJsonToSqlite();
const recoveredReleaseExecutions = recoverInterruptedBatchReleaseTargets();
if (recoveredReleaseExecutions) {
  console.warn(`${recoveredReleaseExecutions} interrupted release execution(s) require operator attention.`);
}
const startupPrinters = await readPrinters();
const bootstrap = await ensureBootstrapAdmin({ printers: startupPrinters, enableDevIdentity: ENABLE_DEV_IDENTITY });
if (!ENABLE_DEV_IDENTITY && bootstrap.users.length && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required when development identity is disabled.');
}
if (bootstrap.created) {
  console.log(`Bootstrap admin created for ${bootstrap.users[0].username}. Password must be changed on first login.`);
}

app.use(express.json({ limit: '32kb' }));
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
const readbackCapabilities = new ReadbackCapabilityRegistry();
const stateChangingOperations = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emulatorManager = new EmulatorManager({
  host: EMULATOR_HOST,
  portOffset: EMULATOR_PORT_OFFSET,
  delay,
  onError: (message) => console.error(message)
});
async function syncEmulatorManager(printers, knownMessages = null) {
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

await syncEmulatorManager(startupPrinters);
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
  if (type === 'batch-release-presence') return getCapabilities(user).viewBatchReleases;

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

const statusCache = new StatusCache({
  staleAfterMs: STALE_AFTER_MS,
  offlineAfterFailures: OFFLINE_AFTER_FAILURES,
  onChange: (event, status) => broadcast(event, status),
  onTransition: (transition, status) => {
    addLog({ action: 'printer-state-transition', printerId: status.printerId, transition, ok: true });
  },
  onStatusSuccess: (status) => {
    recordFaultTransitions(status);
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
  if (printer.mode === 'emulator') return emulatorManager.endpoint(printer);
  return { ip: printer.host, port: printer.port };
}

function runtimePrinterCapabilities(printer) {
  return readbackCapabilities.resolve(printer);
}

function printerForClient(printer) {
  return { ...printer, capabilities: runtimePrinterCapabilities(printer) };
}

async function readCurrentMessageForPrinter(printer, target, { force = false, suppressAutoFailure = false } = {}) {
  const capabilities = runtimePrinterCapabilities(printer);
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
        const result = {
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
        };
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
    const status = assertPacketResponse('E', await wsiClient.sendCommand({ printerId: printer.id, ...target, command: 'E' }));
    const responseTimeMs = Date.now() - startedAt;
    const capabilities = runtimePrinterCapabilities(printer);
    const cached = statusCache.applySuccess(printer.id, {
      ...(message ? { selectedMessage: message.currentMessage } : {}),
      messageVerification: message ? 'verified' : 'unsupported',
      rawStatus: status.value,
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
      model: printer.model,
      capabilities,
      enabled: printer.enabled,
      status: status.value,
      checkedAt: cached.lastSuccessfulAt,
      elapsedMs: responseTimeMs
    };
  });
}

async function legacySetPrinterMessage(printer, body) {
  const target = printerTarget(printer);
  const { messageName, fieldName, fieldValue } = body;
  validateAscii(messageName, 'Message name', 30);
  validateAscii(fieldName, 'User field name', 30);
  validateAscii(fieldValue, 'User field value', 50);

  return runCoderOperation(printer, 'message-update', async (id) => {
    const startedAt = Date.now();
    const update = await wsiClient.sendCommand({ printerId: printer.id, ...target, command: `U${fieldName}\n${fieldValue}` });
    if (update.kind !== 'ack') throw new Error(failureMessage(`U${fieldName}\n${fieldValue}`, update));
    await delay(BETWEEN_COMMAND_DELAY_MS);

    const select = await wsiClient.sendCommand({ printerId: printer.id, ...target, command: `M${messageName}` });
    if (select.kind !== 'ack') throw new Error(failureMessage(`M${messageName}`, select));
    await delay(BETWEEN_COMMAND_DELAY_MS);

    const selected = await readCurrentMessageForPrinter(printer, target, { suppressAutoFailure: true });
    if (selected) await delay(BETWEEN_COMMAND_DELAY_MS);
    const status = assertPacketResponse('E', await wsiClient.sendCommand({ printerId: printer.id, ...target, command: 'E' }));
    const responseTimeMs = Date.now() - startedAt;
    const capabilities = runtimePrinterCapabilities(printer);
    const cached = statusCache.applySuccess(printer.id, {
      ...(selected ? { selectedMessage: selected.currentMessage } : {}),
      messageVerification: selected ? 'verified' : 'unsupported',
      rawStatus: status.value,
      responseTimeMs
    });

    const messageMatches = selected ? selected.currentMessage === messageName : null;
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
      model: printer.model,
      capabilities,
      enabled: printer.enabled,
      online: true,
      ok: messageMatches !== false,
      messageMatches,
      verificationAvailable: Boolean(selected),
      expectedMessage: messageName,
      selectedMessage: selected?.currentMessage || null,
      fieldName,
      fieldValue,
      fieldUpdateAcknowledged: update.value,
      status: status.value,
      acknowledgements: { update: update.value, select: select.value },
      checkedAt: cached.lastSuccessfulAt,
      elapsedMs: responseTimeMs
    };
  });
}

async function setPrinterMessage(printer, body) {
  if (!body?.messageId) return legacySetPrinterMessage(printer, body);

  let message;
  let fields;
  try {
    const printers = await readPrinters();
    const messages = await loadMessages(undefined, { printers });
    message = getMessageForPrinter(messages, body.messageId, printer.id);
    if (body.expectedDefinitionHash && messageDefinitionHash(message) !== body.expectedDefinitionHash) {
      const error = new Error('The message definition changed after it was reviewed. Create a new job and review it again.');
      error.statusCode = 409;
      throw error;
    }
    fields = validateMessageFields(message, body.fields || {});
  } catch (error) {
    error.statusCode = error.statusCode || 400;
    throw error;
  }
  const target = printerTarget(printer);
  const capabilities = runtimePrinterCapabilities(printer);

  return runCoderOperation(printer, 'message-update', async (id) =>
    executeMessageUpdate({
      printer,
      target,
      message,
      fields,
      operationId: id,
      productionDate: body.productionDate,
      supportsCurrentMessageReadback: capabilities.currentMessageReadback === true,
      sendCommand: (command) => wsiClient.sendCommand(command),
      delay: () => delay(BETWEEN_COMMAND_DELAY_MS),
      applySuccess: (status) => statusCache.applySuccess(printer.id, status)
    })
  );
}

app.get('/api/config', (_req, res) => {
  res.json({
    printerIp: DEFAULT_PRINTER_IP,
    printerPort: DEFAULT_PRINTER_PORT,
    timeoutMs: COMMAND_TIMEOUT_MS,
    emulatorIp: EMULATOR_HOST,
    emulatorPort: EMULATOR_PORT
  });
});

app.get('/api/health', (_req, res) => {
  try {
    res.json({ ok: true, database: databaseStatus() });
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
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to edit messages.');
    const printers = await readPrinters();
    res.json(enabledMessages(await loadMessages(undefined, { printers })));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
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
    const saved = await saveMessages([...messages, req.body], undefined, { printers });
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

    const updated = {
      ...messages[index],
      ...req.body,
      id: messages[index].id
    };
    messages[index] = updated;
    const saved = await saveMessages(messages, undefined, { printers });
    await syncEmulatorManager(printers, saved);
    broadcast('messages-updated', { messages: saved });
    res.json({ ok: true, message: saved[index] });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
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
  let selectedMessage = null;
  for (const printerId of specification.printerIds || []) {
    const printer = printerMap.get(printerId);
    if (!printer) throw new Error(`Printer ${printerId} was not found.`);
    const message = getMessageForPrinter(messages, specification.messageId, printerId);
    selectedMessage = selectedMessage || message;
  }
  if (!selectedMessage) throw new Error('Select at least one permitted printer.');
  if (selectedMessage.previewLines.length !== 2) throw new Error('Production release messages must define exactly two preview lines.');
  const allowedSources = new Set(['run_code', 'brew_sheet_product', 'brew_number', 'batch_number']);
  const mappings = Array.isArray(specification.fieldMappings) ? specification.fieldMappings : [];
  const mappingByKey = new Map(mappings.map((mapping) => [mapping.fieldKey, mapping.source]));
  for (const field of selectedMessage.fields) {
    const source = mappingByKey.get(field.key);
    if (!allowedSources.has(source)) throw new Error(`Choose a release value source for message field ${field.label}.`);
  }
  return {
    ...input,
    specification: {
      ...specification,
      fieldMappings: selectedMessage.fields.map((field) => ({ fieldKey: field.key, source: mappingByKey.get(field.key) })),
      bestBeforeMonths: selectedMessage.dateRule.months,
      firstLineTemplate: selectedMessage.previewLines[0],
      secondLineTemplate: selectedMessage.previewLines[1]
    }
  };
}

function visibleBatchRelease(user, release) {
  const capabilities = getCapabilities(user);
  if (!capabilities.viewBatchReleases) return null;
  if (!user.roles?.includes('operator') || capabilities.viewAllPrinters) return release;
  if (!['released', 'applying', 'awaiting_print_check', 'completed', 'failed'].includes(release.status)) return null;
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
  if (!capabilities.createBatchReleases && !capabilities.manageProductMasters) {
    return forbidden(res, 'You do not have permission to view product masters.');
  }
  res.json(listProductMasters({ enabledOnly: req.query.enabled === 'true' }));
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
    const input = await validateProductMasterInput({ ...req.body, specification: req.body?.specification || current.specification });
    const master = updateProductMaster(req.params.id, input, user);
    addLog({ action: 'product-master-version-created', ...auditActor(user), targetType: 'product-master', targetId: master.id, details: { productCode: master.productCode, version: master.currentVersion, ok: true } });
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
        batchNumber: release.batchNumber,
        plannedProductionAt: release.plannedProductionAt,
        printerIds: release.printerIds,
        ok: true
      }
    });
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
    const release = claimBatchReleaseReview(req.params.id, user);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    broadcast('batch-release-presence', { releaseId: release.id, reviewClaim: release.reviewClaim });
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
    res.json({ ok: true, release });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

async function releaseExecutionContext(release, printerId, user) {
  if (!canOperatePrinter(user, printerId)) {
    const error = new Error('You do not have permission to operate this printer.');
    error.statusCode = 403;
    throw error;
  }
  const target = release.executionTargets?.find((item) => item.printerId === printerId);
  if (!target) {
    const error = new Error('This printer is not assigned to the release.');
    error.statusCode = 404;
    throw error;
  }
  const printers = await readPrinters();
  const printer = printers.find((item) => item.id === printerId);
  if (!printer) throw new Error(`Printer ${printerId} was not found.`);
  if (!printer.enabled) {
    const error = new Error(`${printer.name} is disabled.`);
    error.statusCode = 409;
    throw error;
  }
  if (!release.expectedOutput?.messageId) throw new Error('The approved release has no executable message payload.');
  const messages = await loadMessages(undefined, { printers });
  const message = getMessageForPrinter(messages, release.expectedOutput.messageId, printerId);
  const preview = renderPreview(message, release.expectedOutput.fields || {}, { productionDate: release.plannedProductionAt });
  if (preview.rendered !== release.expectedOutput.rendered) {
    const error = new Error('The stored message definition no longer matches the approved release. Return it for a new review.');
    error.statusCode = 409;
    throw error;
  }
  return { printer, target, message };
}

app.post('/api/batch-releases/:id/targets/:printerId/apply', async (req, res) => {
  let began = false;
  let user;
  try {
    user = requireUser(req, res);
    if (!user) return;
    const release = getBatchRelease(req.params.id);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    const { printer } = await releaseExecutionContext(release, req.params.printerId, user);
    if (stateChangingOperations.has(printer.id)) {
      const error = new Error('A message update is already in progress on this printer.');
      error.statusCode = 409;
      throw error;
    }

    beginBatchReleaseTarget(release.id, printer.id, user);
    began = true;
    stateChangingOperations.add(printer.id);
    addLog({
      action: 'batch-release-application-started', ...auditActor(user), targetType: 'batch-release', targetId: release.id,
      printerId: printer.id, details: { printerId: printer.id, brewSheetProduct: release.brewSheetProduct, ok: true }
    });
    broadcast('batch-release-execution', { releaseId: release.id, printerId: printer.id, status: 'applying' });

    const result = await setPrinterMessage(printer, {
      messageId: release.expectedOutput.messageId,
      fields: release.expectedOutput.fields || {},
      productionDate: release.plannedProductionAt
    });
    insertMessageUpdateEvent(result, user);
    if (result.ok && result.expectedOutput) await persistExpectedOutput(printer.id, result.expectedOutput);
    const updated = finishBatchReleaseTarget(release.id, printer.id, result);
    addLog({
      action: result.ok && result.messageMatches !== false ? 'batch-release-application-sent' : 'batch-release-application-failed',
      ...auditActor(user), targetType: 'batch-release', targetId: release.id, printerId: printer.id,
      details: { printerId: printer.id, operationId: result.operationId, selectedMessage: result.selectedMessage, status: updated.status, ok: result.ok && result.messageMatches !== false }
    });
    broadcast('printer-status', result);
    broadcast('batch-release-execution', { releaseId: release.id, printerId: printer.id, status: updated.status });
    res.status(result.ok && result.messageMatches !== false ? 200 : 409).json({ ok: result.ok && result.messageMatches !== false, release: visibleBatchRelease(user, updated), result });
  } catch (error) {
    const failure = error instanceof MessageUpdateError && error.result
      ? { ...error.result, ok: false, error: error.message, checkedAt: new Date().toISOString() }
      : { ok: false, printerId: req.params.printerId, error: error.message, checkedAt: new Date().toISOString() };
    if (began) {
      const updated = finishBatchReleaseTarget(req.params.id, req.params.printerId, failure);
      insertMessageUpdateEvent(failure, user || {});
      addLog({
        action: 'batch-release-application-failed', ...(user ? auditActor(user) : {}), targetType: 'batch-release',
        targetId: req.params.id, printerId: req.params.printerId,
        details: { printerId: req.params.printerId, error: error.message, status: updated.status, ok: false }
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
    if (!canOperatePrinter(user, req.params.printerId)) return forbidden(res, 'You do not have permission to operate this printer.');
    const release = verifyBatchReleaseTarget(req.params.id, req.params.printerId, {
      passed: req.body?.passed === true,
      reason: req.body?.reason
    }, user);
    if (!release) return res.status(404).json({ ok: false, error: 'Batch release was not found.' });
    const passed = req.body?.passed === true;
    addLog({
      action: passed ? 'batch-release-print-verified' : 'batch-release-print-failed', ...auditActor(user),
      targetType: 'batch-release', targetId: release.id, printerId: req.params.printerId,
      details: { printerId: req.params.printerId, reason: passed ? null : String(req.body?.reason || '').trim(), status: release.status, ok: passed }
    });
    broadcast('batch-release-execution', { releaseId: release.id, printerId: req.params.printerId, status: release.status });
    res.json({ ok: true, release: visibleBatchRelease(user, release) });
  } catch (error) {
    res.status(error.statusCode || 409).json({ ok: false, error: error.message });
  }
});

function visibleMessageJob(user, job) {
  if (!job) return null;
  const targets = job.targets
    .filter((target) => canViewPrinter(user, target.printerId))
    .map((target) => ({
      ...target,
      canOperate: canOperatePrinter(user, target.printerId) && target.status === 'pending'
    }));
  return targets.length ? { ...job, targets } : null;
}

function messageDefinitionHash(message) {
  return crypto.createHash('sha256').update(JSON.stringify({
    printerMessageName: message.printerMessageName,
    fields: message.fields,
    dateRule: message.dateRule,
    previewLines: message.previewLines
  })).digest('hex');
}

function requestedJobTargetIds(body, targets, user) {
  const requested = Array.isArray(body?.printerIds)
    ? [...new Set(body.printerIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : targets.filter((target) => target.status === 'pending' && canOperatePrinter(user, target.printerId)).map((target) => target.printerId);
  const known = new Set(targets.map((target) => target.printerId));
  for (const printerId of requested) {
    if (!known.has(printerId)) {
      const error = new Error(`Printer ${printerId} is not a target of this message job.`);
      error.statusCode = 400;
      throw error;
    }
    if (!canOperatePrinter(user, printerId)) {
      const error = new Error(`You do not have permission to operate printer ${printerId}.`);
      error.statusCode = 403;
      throw error;
    }
    if (targets.find((target) => target.printerId === printerId)?.status !== 'pending') {
      const error = new Error(`Printer ${printerId} is no longer pending for this message job.`);
      error.statusCode = 409;
      throw error;
    }
  }
  return requested;
}

app.get('/api/message-jobs', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    const jobs = listMessageJobs({ limit: req.query.limit }).map((job) => visibleMessageJob(user, job)).filter(Boolean);
    res.json(jobs);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/message-jobs', async (req, res) => {
  return res.status(410).json({ ok: false, error: 'Message jobs have been replaced by controlled production releases.' });
  /* Legacy implementation retained temporarily for migration compatibility.
  try {
    const user = requireUser(req, res);
    if (!user) return;
    if (!canEditMessages(user)) return forbidden(res, 'You do not have permission to create message jobs.');
    const printerIds = [...new Set((Array.isArray(req.body?.printerIds) ? req.body.printerIds : [])
      .map((id) => String(id || '').trim()).filter(Boolean))];
    if (!printerIds.length) return res.status(400).json({ ok: false, error: 'Select at least one target printer.' });

    const printers = await readPrinters();
    const printerMap = new Map(printers.map((printer) => [printer.id, printer]));
    const messages = await loadMessages(undefined, { printers });
    const targets = [];
    let normalizedFields = null;
    let displayName = null;
    for (const printerId of printerIds) {
      const printer = printerMap.get(printerId);
      if (!printer) throw new Error(`Printer ${printerId} was not found.`);
      if (!printer.enabled) throw new Error(`${printer.name} is disabled.`);
      if (!canOperatePrinter(user, printerId)) return forbidden(res, `You do not have permission to operate ${printer.name}.`);
      const message = getMessageForPrinter(messages, req.body?.messageId, printerId);
      const preview = {
        ...renderPreview(message, req.body?.fields || {}, { productionDate: req.body?.productionDate }),
        definitionHash: messageDefinitionHash(message)
      };
      normalizedFields = normalizedFields || preview.fields;
      displayName = displayName || message.displayName;
      targets.push({
        printerId,
        printerName: printer.name,
        printerMessageName: message.printerMessageName,
        preview
      });
    }

    const now = Date.now();
    const expiresHours = Math.min(Math.max(Number(req.body?.expiresHours) || 24, 1), 168);
    const expiresAtMs = req.body?.expiresAt ? new Date(req.body.expiresAt).valueOf() : now + expiresHours * 60 * 60 * 1000;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + 7 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'Job expiry must be within the next seven days.' });
    }
    const job = createMessageJob({
      id: crypto.randomUUID(),
      messageId: req.body?.messageId,
      displayName,
      fields: normalizedFields,
      productionDate: req.body?.productionDate || null,
      createdByUserId: user.developmentIdentity ? null : user.id,
      createdByUsername: user.username,
      expiresAt: new Date(expiresAtMs).toISOString(),
      targets
    });
    addLog({ action: 'message-job-created', actor: user.username, targetId: job.id, messageId: job.messageId, printerIds, ok: true });
    res.status(201).json({ ok: true, job: visibleMessageJob(user, job) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
  */
});

app.post('/api/message-jobs/:id/accept', async (req, res) => {
  return res.status(410).json({ ok: false, error: 'Direct message-job execution is disabled. Use an approved production release.' });
  /* Legacy implementation retained temporarily for migration compatibility.
  try {
    const user = requireUser(req, res);
    if (!user) return;
    let job = getMessageJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: `Message job ${req.params.id} was not found.` });
    if (job.status === 'expired') return res.status(409).json({ ok: false, error: 'This message job has expired.' });
    const printerIds = requestedJobTargetIds(req.body, job.targets, user);
    if (!printerIds.length) return res.status(409).json({ ok: false, error: 'No assigned pending targets are available.' });
    const printers = await readPrinters();
    const printerMap = new Map(printers.map((printer) => [printer.id, printer]));
    const messages = await loadMessages(undefined, { printers });

    const busyPrinterId = printerIds.find((printerId) => stateChangingOperations.has(printerId));
    if (busyPrinterId) {
      return res.status(409).json({ ok: false, error: `Printer ${busyPrinterId} is already processing another message change.` });
    }

    for (const printerId of printerIds) {
      const target = job.targets.find((item) => item.printerId === printerId);
      if (target.status !== 'pending') continue;
      const printer = printerMap.get(printerId);
      if (!printer || !printer.enabled) {
        job = updateMessageJobTarget(job.id, printerId, { status: 'failed', result: { ok: false, error: 'Printer is unavailable or disabled.' } }, user);
        continue;
      }
      let currentAssignment;
      try {
        currentAssignment = getMessageForPrinter(messages, job.messageId, printerId);
      } catch (error) {
        job = updateMessageJobTarget(job.id, printerId, { status: 'failed', result: { ok: false, error: error.message } }, user);
        continue;
      }
      const definitionChanged = target.preview?.definitionHash
        ? messageDefinitionHash(currentAssignment) !== target.preview.definitionHash
        : currentAssignment.printerMessageName !== target.printerMessageName;
      if (definitionChanged) {
        job = updateMessageJobTarget(job.id, printerId, {
          status: 'failed',
          result: { ok: false, error: 'The printer message assignment changed after this job was created. Create a new job and review it again.' }
        }, user);
        continue;
      }
      updateMessageJobTarget(job.id, printerId, { status: 'processing', result: null }, user);
      stateChangingOperations.add(printerId);
      try {
        const result = await setPrinterMessage(printer, {
          messageId: job.messageId,
          fields: job.fields,
          productionDate: job.productionDate,
          expectedDefinitionHash: target.preview?.definitionHash
        });
        insertMessageUpdateEvent(result, user);
        if (result.ok && result.expectedOutput) await persistExpectedOutput(printer.id, result.expectedOutput);
        const targetStatus = result.ok ? 'succeeded' : 'failed';
        job = updateMessageJobTarget(job.id, printerId, { status: targetStatus, result }, user);
        addLog({ action: 'message-job-target-completed', actor: user.username, targetId: job.id, printerId, ok: result.ok, result: targetStatus });
        broadcast('printer-status', result);
      } catch (error) {
        const result = error.result || { ok: false, error: error.message };
        if (error instanceof MessageUpdateError && error.result) insertMessageUpdateEvent(error.result, user);
        job = updateMessageJobTarget(job.id, printerId, { status: 'failed', result }, user);
        addLog({ action: 'message-job-target-failed', actor: user.username, targetId: job.id, printerId, ok: false, error: error.message });
      } finally {
        stateChangingOperations.delete(printerId);
      }
    }
    res.json({ ok: true, job: visibleMessageJob(user, getMessageJob(job.id)) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
  */
});

app.post('/api/message-jobs/:id/decline', (req, res) => {
  try {
    const user = requireUser(req, res);
    if (!user) return;
    let job = getMessageJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: `Message job ${req.params.id} was not found.` });
    const printerIds = requestedJobTargetIds(req.body, job.targets, user);
    if (!printerIds.length) return res.status(409).json({ ok: false, error: 'No assigned pending targets are available.' });
    for (const printerId of printerIds) {
      const target = job.targets.find((item) => item.printerId === printerId);
      if (target.status === 'pending') {
        job = updateMessageJobTarget(job.id, printerId, {
          status: 'declined',
          result: { reason: String(req.body?.reason || 'Declined by operator').slice(0, 200) }
        }, user);
      }
    }
    addLog({ action: 'message-job-declined', actor: user.username, targetId: job.id, printerIds, ok: true });
    res.json({ ok: true, job: visibleMessageJob(user, job) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
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
    res.json(visiblePrinters(user, printers).map(printerForClient));
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
    const visibleIds = new Set(visiblePrinters(user, printers).map((printer) => printer.id));
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
    addLog({ action: 'message-update-start', printerId: printer.id, ok: true, requestedMessage: req.body?.messageId || req.body?.messageName });
    const result = await setPrinterMessage(printer, req.body || {});
    insertMessageUpdateEvent(result, user);
    if (result.ok && result.expectedOutput) await persistExpectedOutput(printer.id, result.expectedOutput);
    addLog({ action: result.messageMatches === false ? 'message-update-mismatch' : 'message-update-success', printerId: printer.id, operationId: result.operationId, requestedMessage: result.requestedMessage || result.expectedMessage, selectedMessage: result.selectedMessage, rawStatus: result.rawStatus, decodedFaultCodes: result.decodedStatus?.faults?.map((fault) => fault.code) || [], fieldResults: result.fieldResults, ...result });
    broadcast('printer-status', result);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    if (error instanceof MessageUpdateError && error.result) {
      const result = { ...error.result, checkedAt: new Date().toISOString() };
      insertMessageUpdateEvent(result, currentUser(req) || {});
      addLog({ action: 'message-update-failure', printerId: req.params.id, ok: false, error: error.message, fieldResults: result.fieldResults, messageSelection: result.messageSelection });
      return res.status(502).json(result);
    }
    if (error.statusCode === 400) {
      addLog({ action: 'message-update-rejected', printerId: req.params.id, ok: false, error: error.message });
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
    addLog({ action: 'message-update-failure', printerId: req.params.id, ok: false, error: error.message });
    broadcast('printer-status', cached);
    res.status(502).json(result);
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
          const result = { ...error.result, checkedAt: new Date().toISOString() };
          insertMessageUpdateEvent(result, user);
          addLog({ action: 'message-update-failure', printerId: printer.id, ok: false, error: error.message, fieldResults: result.fieldResults, messageSelection: result.messageSelection });
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
  if (POLL_INTERVAL_MS > 0) {
    monitor.start();
    setInterval(() => broadcast('heartbeat', { time: new Date().toISOString() }), SSE_HEARTBEAT_MS);
    console.log(`Server-side monitoring every ${POLL_INTERVAL_MS} ms`);
  }
});

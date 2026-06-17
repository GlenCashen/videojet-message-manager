import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrinters, updatePrinter } from './printer-store.js';
import { CoderQueue } from './server/coder-queue.js';
import { Monitor } from './server/monitor.js';
import { StatusCache } from './server/status-cache.js';
import { WsiClient } from './server/wsi-client.js';

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
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || process.env.STATUS_POLL_MS || 5000);
const STALE_AFTER_MS = Number(process.env.STALE_AFTER_MS || 15000);
const OFFLINE_AFTER_FAILURES = Number(process.env.OFFLINE_AFTER_FAILURES || 3);
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 20000);
const ENABLE_UNSAFE_DEVELOPMENT_TOOLS = process.env.ENABLE_UNSAFE_DEVELOPMENT_TOOLS === 'true';
const ENABLE_TEST_ENDPOINTS = process.env.NODE_ENV === 'test' || process.env.ENABLE_TEST_ENDPOINTS === 'true';

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const commandLog = [];
const MAX_LOG_ENTRIES = 200;
const eventClients = new Set();
const coderQueue = new CoderQueue();
const wsiClient = new WsiClient({ timeoutMs: COMMAND_TIMEOUT_MS });
const stateChangingOperations = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function addLog(entry) {
  const logEntry = { time: new Date().toISOString(), ...entry };
  commandLog.unshift(logEntry);
  if (commandLog.length > MAX_LOG_ENTRIES) commandLog.length = MAX_LOG_ENTRIES;
  broadcast('log-entry', logEntry);
}

function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const client of eventClients) {
    try {
      client.write(`event: ${type}\ndata: ${data}\n\n`);
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
  onChange: (event, status) => broadcast(event, status)
});

function validateAscii(value, label, maxLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new Error(`${label} must be 1-${maxLength} characters.`);
  }
  if (!/^[\x20-\x7E]+$/.test(value)) {
    throw new Error(`${label} must contain printable ASCII characters only.`);
  }
}

function packetResponse(value) {
  return Buffer.concat([Buffer.from([0x02]), Buffer.from(value, 'ascii'), Buffer.from([0x03])]);
}

function acknowledgement(command, ok = true) {
  const sum = [...Buffer.from(command, 'ascii')].reduce((total, byte) => (total + byte) & 0xFF, 0);
  return Buffer.from(`${ok ? '$' : '!'}${sum.toString(16).padStart(2, '0').toUpperCase()}`, 'ascii');
}

function printerConfig(body = {}) {
  const ip = body.ip || DEFAULT_PRINTER_IP;
  const port = Number(body.port || DEFAULT_PRINTER_PORT);
  if (!net.isIP(ip)) throw new Error('Invalid printer IP address.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid printer TCP port.');
  return { ip, port };
}

function printerTarget(printer) {
  if (printer.mode === 'emulator') {
    return { ip: EMULATOR_HOST, port: EMULATOR_PORT };
  }
  return { ip: printer.host, port: printer.port };
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
      statusCache.applyFailure(printer.id, error);
      statusCache.completeOperation(printer.id);
      broadcast('operation-failed', { ...statusCache.get(printer.id), error: error.message });
      throw error;
    }
  });
}

async function refreshPrinterStatus(printer, operation = 'check') {
  const target = printerTarget(printer);
  return runCoderOperation(printer, operation, async (id) => {
    const startedAt = Date.now();
    const message = await wsiClient.sendCommand({ printerId: printer.id, ...target, command: 'Q' });
    await delay(BETWEEN_COMMAND_DELAY_MS);
    const status = await wsiClient.sendCommand({ printerId: printer.id, ...target, command: 'E' });
    const responseTimeMs = Date.now() - startedAt;
    const cached = statusCache.applySuccess(printer.id, {
      selectedMessage: message.value,
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
      enabled: printer.enabled,
      status: status.value,
      checkedAt: cached.lastSuccessfulAt,
      elapsedMs: responseTimeMs
    };
  });
}

async function setPrinterMessage(printer, body) {
  const target = printerTarget(printer);
  const { messageName, fieldName, fieldValue } = body;
  validateAscii(messageName, 'Message name', 30);
  validateAscii(fieldName, 'User field name', 30);
  validateAscii(fieldValue, 'User field value', 50);

  return runCoderOperation(printer, 'message-update', async (id) => {
    const startedAt = Date.now();
    const update = await wsiClient.sendCommand({ printerId: printer.id, ...target, command: `U${fieldName}\n${fieldValue}` });
    if (update.kind !== 'ack') throw new Error(`User-field update was not acknowledged: ${update.value}`);
    await delay(BETWEEN_COMMAND_DELAY_MS);

    const select = await wsiClient.sendCommand({ printerId: printer.id, ...target, command: `M${messageName}` });
    if (select.kind !== 'ack') throw new Error(`Message selection was not acknowledged: ${select.value}`);
    await delay(BETWEEN_COMMAND_DELAY_MS);

    const selected = await wsiClient.sendCommand({ printerId: printer.id, ...target, command: 'Q' });
    await delay(BETWEEN_COMMAND_DELAY_MS);
    const status = await wsiClient.sendCommand({ printerId: printer.id, ...target, command: 'E' });
    const responseTimeMs = Date.now() - startedAt;
    const cached = statusCache.applySuccess(printer.id, {
      selectedMessage: selected.value,
      rawStatus: status.value,
      responseTimeMs
    });

    const messageMatches = selected.value === messageName;
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
      enabled: printer.enabled,
      online: true,
      ok: messageMatches,
      messageMatches,
      expectedMessage: messageName,
      selectedMessage: selected.value,
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

const emulator = {
  selectedMessage: '9 MONTH',
  availableMessages: ['9 MONTH', '12 MONTH'],
  userFields: { TEST: 'TEST123' },
  status: '0000002',
  softwarePartNumber: '1.0.484.0       ',
  printCounter: 2141608,
  productCounter: 0,
  responseDelayMs: 40,
  enabled: true,
  failNextCommand: false
};

function emulatorSnapshot() {
  return {
    host: EMULATOR_HOST,
    port: EMULATOR_PORT,
    selectedMessage: emulator.selectedMessage,
    availableMessages: emulator.availableMessages,
    userFields: emulator.userFields,
    status: emulator.status,
    printCounter: emulator.printCounter,
    productCounter: emulator.productCounter,
    responseDelayMs: emulator.responseDelayMs,
    enabled: emulator.enabled,
    failNextCommand: emulator.failNextCommand
  };
}

function handleEmulatorCommand(command) {
  if (emulator.failNextCommand) {
    emulator.failNextCommand = false;
    return acknowledgement(command, false);
  }

  const type = command[0];
  const data = command.slice(1);

  switch (type) {
    case 'Q': return packetResponse(emulator.selectedMessage);
    case 'E': return packetResponse(emulator.status);
    case 'H': return packetResponse(emulator.softwarePartNumber);
    case 'M': {
      if (!emulator.availableMessages.includes(data)) return acknowledgement(command, false);
      emulator.selectedMessage = data;
      return acknowledgement(command, true);
    }
    case 'U': {
      const separator = data.indexOf('\n');
      if (separator < 1) return acknowledgement(command, false);
      const fieldName = data.slice(0, separator);
      const fieldValue = data.slice(separator + 1);
      if (!(fieldName in emulator.userFields) || fieldValue.length < 1 || fieldValue.length > 50) {
        return acknowledgement(command, false);
      }
      emulator.userFields[fieldName] = fieldValue;
      return acknowledgement(command, true);
    }
    case 'D': {
      if (!(data in emulator.userFields)) return acknowledgement(command, false);
      emulator.userFields[data] = '';
      return acknowledgement(command, true);
    }
    case 'G': {
      const value = data.toUpperCase() === 'A' ? emulator.printCounter : emulator.productCounter;
      return packetResponse(String(value).padStart(10, '0'));
    }
    case 'O': return acknowledgement(command, data === '0' || data === '1');
    default: return acknowledgement(command, false);
  }
}

const emulatorServer = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const start = buffer.indexOf(0x02);
    const end = buffer.indexOf(0x03, start + 1);
    if (start < 0 || end < 0) return;

    const command = buffer.subarray(start + 1, end).toString('ascii');
    await delay(emulator.responseDelayMs);
    if (!emulator.enabled) {
      socket.destroy();
      return;
    }
    socket.end(handleEmulatorCommand(command));
  });
});

emulatorServer.on('error', (error) => {
  console.error(`WSI emulator failed on ${EMULATOR_HOST}:${EMULATOR_PORT}: ${error.message}`);
});

emulatorServer.listen(EMULATOR_PORT, EMULATOR_HOST, () => {
  console.log(`WSI emulator listening on ${EMULATOR_HOST}:${EMULATOR_PORT}`);
});

app.get('/api/config', (_req, res) => {
  res.json({
    printerIp: DEFAULT_PRINTER_IP,
    printerPort: DEFAULT_PRINTER_PORT,
    timeoutMs: COMMAND_TIMEOUT_MS,
    emulatorIp: EMULATOR_HOST,
    emulatorPort: EMULATOR_PORT
  });
});

app.get('/api/logs', (_req, res) => res.json(commandLog));
app.get('/api/emulator', (_req, res) => res.json(emulatorSnapshot()));

app.get('/api/debug/wsi-counters', (_req, res) => {
  if (!ENABLE_TEST_ENDPOINTS) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json(wsiClient.getCounters());
});

app.post('/api/debug/wsi-counters/reset', (_req, res) => {
  if (!ENABLE_TEST_ENDPOINTS) return res.status(404).json({ ok: false, error: 'Not found.' });
  wsiClient.resetCounters();
  res.json({ ok: true });
});

app.get('/api/events', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
  sendEvent(res, 'connected', { connected: true });
  sendEvent(res, 'logs-snapshot', commandLog);
  sendEvent(res, 'emulator-snapshot', emulatorSnapshot());
  try {
    const printers = await readPrinters();
    statusCache.syncPrinters(printers);
    sendEvent(res, 'status-snapshot', statusCache.all());
    sendEvent(res, 'fleet-snapshot', printers);
  } catch (error) {
    sendEvent(res, 'stream-error', { error: error.message });
  }
});

app.get('/api/printers', async (_req, res) => {
  try {
    const printers = await readPrinters();
    statusCache.syncPrinters(printers);
    res.json(printers);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/printers/status', async (_req, res) => {
  try {
    statusCache.syncPrinters(await readPrinters());
    res.json(statusCache.all());
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/printers/:id', async (req, res) => {
  try {
    const printers = await readPrinters();
    statusCache.syncPrinters(printers);
    const printer = printers.find((item) => item.id === req.params.id);
    if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.params.id} was not found.` });
    res.json(printer);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/printers/:id/status', async (req, res) => {
  try {
    const printers = await readPrinters();
    statusCache.syncPrinters(printers);
    const printer = printers.find((item) => item.id === req.params.id);
    if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.params.id} was not found.` });
    res.json(statusCache.get(req.params.id));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put('/api/printers/:id', async (req, res) => {
  try {
    const printers = await updatePrinter(req.params.id, req.body || {});
    statusCache.syncPrinters(printers);
    const printer = printers.find((item) => item.id === req.params.id);
    broadcast('printer-config', printer);
    broadcast('status-snapshot', statusCache.all());
    res.json({ ok: true, printer });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/printers/:id/check', async (req, res) => {
  const startedAt = Date.now();
  try {
    const printers = await readPrinters();
    const printer = printers.find((item) => item.id === req.params.id);

    if (!printer) {
      return res.status(404).json({ ok: false, error: `Printer ${req.params.id} was not found.` });
    }
    if (!printer.enabled) {
      return res.status(409).json({ ok: false, error: `${printer.name} is disabled.` });
    }

    const result = await refreshPrinterStatus(printer, 'check');
    addLog({ action: 'printer-check', printerId: printer.id, operationId: result.operationId, ok: true, ...result });
    broadcast('printer-status', { ok: true, ...result });
    res.json({ ok: true, ...result });
  } catch (error) {
    const result = {
      ok: false,
      printerId: req.params.id,
      online: false,
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
    broadcast('printer-status', result);
    res.status(502).json(result);
  }
});

app.post('/api/printers/:id/set', async (req, res) => {
  try {
    const printers = await readPrinters();
    statusCache.syncPrinters(printers);
    const printer = printers.find((item) => item.id === req.params.id);

    if (!printer) {
      return res.status(404).json({ ok: false, error: `Printer ${req.params.id} was not found.` });
    }
    if (!printer.enabled) {
      return res.status(409).json({ ok: false, error: `${printer.name} is disabled.` });
    }
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
    addLog({ action: 'message-update-start', printerId: printer.id, ok: true, requestedMessage: req.body?.messageName });
    const result = await setPrinterMessage(printer, req.body || {});
    addLog({ action: 'message-update-success', printerId: printer.id, operationId: result.operationId, requestedMessage: result.expectedMessage, verifiedSelectedMessage: result.selectedMessage, fieldUpdateAcknowledged: result.fieldUpdateAcknowledged, rawStatus: result.rawStatus, decodedFaultCodes: result.decodedStatus?.faults?.map((fault) => fault.code) || [], ...result });
    broadcast('printer-status', result);
    res.status(result.messageMatches ? 200 : 409).json(result);
  } catch (error) {
    const result = {
      ok: false,
      printerId: req.params.id,
      online: false,
      error: error.message,
      checkedAt: new Date().toISOString()
    };
    addLog({ action: 'message-update-failure', printerId: req.params.id, ok: false, error: error.message });
    broadcast('printer-status', result);
    res.status(502).json(result);
  } finally {
    stateChangingOperations.delete(req.params.id);
  }
});

app.post('/api/printers/check-all', async (_req, res) => {
  const printers = (await readPrinters()).filter((printer) => printer.enabled);
  const results = [];

  for (const printer of printers) {
    try {
      const result = await refreshPrinterStatus(printer, 'check');
      results.push({ ok: true, ...result });
      addLog({ action: 'printer-check', printerId: printer.id, operationId: result.operationId, ok: true, ...result });
      broadcast('printer-status', { ok: true, ...result });
    } catch (error) {
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
        online: false,
        error: error.message,
        checkedAt: new Date().toISOString()
      };
      results.push(result);
      addLog({ action: 'printer-check', printerId: printer.id, ...result });
      broadcast('printer-status', result);
    }
  }

  res.json({ ok: results.every((result) => result.ok), results });
});

app.post('/api/emulator', (req, res) => {
  const body = req.body || {};
  if (typeof body.selectedMessage === 'string' && emulator.availableMessages.includes(body.selectedMessage)) {
    emulator.selectedMessage = body.selectedMessage;
  }
  if (typeof body.status === 'string' && /^[0-9A-F]{7}$/i.test(body.status)) emulator.status = body.status.toUpperCase();
  if (Number.isInteger(body.responseDelayMs) && body.responseDelayMs >= 0 && body.responseDelayMs <= 10000) {
    emulator.responseDelayMs = body.responseDelayMs;
  }
  if (typeof body.enabled === 'boolean') emulator.enabled = body.enabled;
  if (typeof body.failNextCommand === 'boolean') emulator.failNextCommand = body.failNextCommand;
  if (body.userFields && typeof body.userFields === 'object' && !Array.isArray(body.userFields)) {
    for (const [name, value] of Object.entries(body.userFields)) {
      if (/^[\x20-\x7E]{1,30}$/.test(name) && typeof value === 'string' && value.length <= 50) {
        emulator.userFields[name] = value;
      }
    }
  }
  const snapshot = emulatorSnapshot();
  broadcast('emulator-snapshot', snapshot);
  res.json(snapshot);
});

app.post('/api/emulator/reset', (_req, res) => {
  emulator.selectedMessage = '9 MONTH';
  emulator.userFields = { TEST: 'TEST123' };
  emulator.status = '0000002';
  emulator.responseDelayMs = 40;
  emulator.enabled = true;
  emulator.failNextCommand = false;
  const snapshot = emulatorSnapshot();
  broadcast('emulator-snapshot', snapshot);
  res.json(snapshot);
});

app.post('/api/check', async (req, res) => {
  try {
    if (req.body?.printerId) {
      const printers = await readPrinters();
      statusCache.syncPrinters(printers);
      const printer = printers.find((item) => item.id === req.body.printerId);
      if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.body.printerId} was not found.` });
      const result = await refreshPrinterStatus(printer, 'check');
      addLog({ action: 'check', printerId: printer.id, operationId: result.operationId, ok: true, ...result });
      return res.json({ ok: true, ...result });
    }
    if (!ENABLE_UNSAFE_DEVELOPMENT_TOOLS) {
      return res.status(403).json({ ok: false, error: 'Arbitrary printer targets are disabled. Use printerId.' });
    }

    const { ip, port } = printerConfig(req.body);
    const { message, status } = await coderQueue.run(`unsafe:${ip}:${port}`, { operation: 'unsafe-check' }, async () => {
      const message = await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: 'Q' });
      await delay(BETWEEN_COMMAND_DELAY_MS);
      const status = await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: 'E' });
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
    if (req.body?.printerId) {
      const printers = await readPrinters();
      statusCache.syncPrinters(printers);
      const printer = printers.find((item) => item.id === req.body.printerId);
      if (!printer) return res.status(404).json({ ok: false, error: `Printer ${req.body.printerId} was not found.` });
      if (!printer.enabled) return res.status(409).json({ ok: false, error: `${printer.name} is disabled.` });
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
        addLog({ action: 'message-update-success', printerId: printer.id, operationId: result.operationId, ...result });
        return res.status(result.messageMatches ? 200 : 409).json(result);
      } finally {
        stateChangingOperations.delete(printer.id);
      }
    }
    if (!ENABLE_UNSAFE_DEVELOPMENT_TOOLS) {
      return res.status(403).json({ ok: false, error: 'Arbitrary printer targets are disabled. Use printerId.' });
    }

    const { ip, port } = printerConfig(req.body);
    const { messageName, fieldName, fieldValue } = req.body;
    validateAscii(messageName, 'Message name', 30);
    validateAscii(fieldName, 'User field name', 30);
    validateAscii(fieldValue, 'User field value', 50);

    const { update, select, selected, status } = await coderQueue.run(`unsafe:${ip}:${port}`, { operation: 'unsafe-set' }, async () => {
      const update = await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: `U${fieldName}\n${fieldValue}` });
      if (update.kind !== 'ack') throw new Error(`User-field update was not acknowledged: ${update.value}`);
      await delay(BETWEEN_COMMAND_DELAY_MS);

      const select = await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: `M${messageName}` });
      if (select.kind !== 'ack') throw new Error(`Message selection was not acknowledged: ${select.value}`);
      await delay(BETWEEN_COMMAND_DELAY_MS);

      const selected = await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: 'Q' });
      await delay(BETWEEN_COMMAND_DELAY_MS);
      const status = await wsiClient.sendCommand({ printerId: `unsafe:${ip}:${port}`, ip, port, command: 'E' });
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
    statusCache.syncPrinters(printers);
    return printers;
  },
  pollPrinter: async (printer) => {
    try {
      await refreshPrinterStatus(printer, 'poll');
    } catch (_error) {
      // The cache and SSE stream are updated by runCoderOperation failure handling.
    }
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

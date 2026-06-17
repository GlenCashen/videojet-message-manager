import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrinters, updatePrinter } from './printer-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 8080);
const DEFAULT_PRINTER_IP = process.env.PRINTER_IP || '192.168.100.2';
const DEFAULT_PRINTER_PORT = Number(process.env.PRINTER_PORT || 3100);
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 5000);
const BETWEEN_COMMAND_DELAY_MS = Number(process.env.BETWEEN_COMMAND_DELAY_MS || 150);
const EMULATOR_HOST = process.env.EMULATOR_HOST || '127.0.0.1';
const EMULATOR_PORT = Number(process.env.EMULATOR_PORT || 3100);

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const commandLog = [];
const MAX_LOG_ENTRIES = 200;
const printerQueues = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function addLog(entry) {
  commandLog.unshift({ time: new Date().toISOString(), ...entry });
  if (commandLog.length > MAX_LOG_ENTRIES) commandLog.length = MAX_LOG_ENTRIES;
}

function validateAscii(value, label, maxLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new Error(`${label} must be 1-${maxLength} characters.`);
  }
  if (!/^[\x20-\x7E]+$/.test(value)) {
    throw new Error(`${label} must contain printable ASCII characters only.`);
  }
}

function buildPacket(command) {
  const payload = Buffer.from(command, 'ascii');
  return Buffer.concat([Buffer.from([0x02]), payload, Buffer.from([0x03])]);
}

function packetResponse(value) {
  return Buffer.concat([Buffer.from([0x02]), Buffer.from(value, 'ascii'), Buffer.from([0x03])]);
}

function acknowledgement(command, ok = true) {
  const sum = [...Buffer.from(command, 'ascii')].reduce((total, byte) => (total + byte) & 0xFF, 0);
  return Buffer.from(`${ok ? '$' : '!'}${sum.toString(16).padStart(2, '0').toUpperCase()}`, 'ascii');
}

function decodeResponse(buffer) {
  const hex = [...buffer].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const ascii = buffer.toString('ascii');

  if (buffer.length >= 2 && buffer[0] === 0x02 && buffer.at(-1) === 0x03) {
    return { kind: 'packet', value: buffer.subarray(1, -1).toString('ascii'), ascii, hex };
  }

  if (/^[!$][0-9A-F]{2}$/i.test(ascii)) {
    return { kind: ascii.startsWith('$') ? 'ack' : 'nack', value: ascii, ascii, hex };
  }

  return { kind: 'raw', value: ascii, ascii, hex };
}

function sendWsiCommand({ ip, port, command, timeoutMs = COMMAND_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const chunks = [];
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(buildPacket(command)));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (data.length >= 3 && (/^[!$][0-9A-F]{2}$/i.test(data.toString('ascii')) || data.at(-1) === 0x03)) {
        finish(null, decodeResponse(data));
      }
    });
    socket.on('timeout', () => finish(new Error(`Printer did not respond within ${timeoutMs} ms.`)));
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) {
        const data = Buffer.concat(chunks);
        if (data.length) finish(null, decodeResponse(data));
        else finish(new Error('Printer closed the connection without replying.'));
      }
    });
    socket.connect(port, ip);
  });
}

function targetKey({ ip, host, port }) {
  return `${host || ip}:${port}`;
}

async function runSequentially(target, task) {
  const key = targetKey(target);
  const previous = printerQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => current);
  printerQueues.set(key, queued);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (printerQueues.get(key) === queued) printerQueues.delete(key);
  }
}

function printerConfig(body = {}) {
  const ip = body.ip || DEFAULT_PRINTER_IP;
  const port = Number(body.port || DEFAULT_PRINTER_PORT);
  if (!net.isIP(ip)) throw new Error('Invalid printer IP address.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid printer TCP port.');
  return { ip, port };
}

async function checkPrinterConnection(printer) {
  return runSequentially({ host: printer.host, port: printer.port }, async () => {
    const startedAt = Date.now();
    const message = await sendWsiCommand({ ip: printer.host, port: printer.port, command: 'Q' });
    await delay(BETWEEN_COMMAND_DELAY_MS);
    const status = await sendWsiCommand({ ip: printer.host, port: printer.port, command: 'E' });

    return {
      id: printer.id,
      name: printer.name,
      location: printer.location,
      host: printer.host,
      port: printer.port,
      mode: printer.mode,
      enabled: printer.enabled,
      online: true,
      selectedMessage: message.value,
      status: status.value,
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt
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

app.get('/api/printers', async (_req, res) => {
  try {
    res.json(await readPrinters());
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.put('/api/printers/:id', async (req, res) => {
  try {
    const printers = await updatePrinter(req.params.id, req.body || {});
    const printer = printers.find((item) => item.id === req.params.id);
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

    const result = await checkPrinterConnection(printer);
    addLog({ action: 'printer-check', printerId: printer.id, ok: true, ...result });
    res.json({ ok: true, ...result });
  } catch (error) {
    addLog({
      action: 'printer-check',
      printerId: req.params.id,
      ok: false,
      error: error.message,
      elapsedMs: Date.now() - startedAt
    });
    res.status(502).json({ ok: false, printerId: req.params.id, online: false, error: error.message });
  }
});

app.post('/api/printers/check-all', async (_req, res) => {
  const printers = (await readPrinters()).filter((printer) => printer.enabled);
  const results = [];

  for (const printer of printers) {
    try {
      const result = await checkPrinterConnection(printer);
      results.push({ ok: true, ...result });
      addLog({ action: 'printer-check', printerId: printer.id, ok: true, ...result });
    } catch (error) {
      const result = {
        ok: false,
        id: printer.id,
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
  res.json(emulatorSnapshot());
});

app.post('/api/emulator/reset', (_req, res) => {
  emulator.selectedMessage = '9 MONTH';
  emulator.userFields = { TEST: 'TEST123' };
  emulator.status = '0000002';
  emulator.responseDelayMs = 40;
  emulator.enabled = true;
  emulator.failNextCommand = false;
  res.json(emulatorSnapshot());
});

app.post('/api/check', async (req, res) => {
  try {
    const { ip, port } = printerConfig(req.body);
    const { message, status } = await runSequentially({ ip, port }, async () => {
      const message = await sendWsiCommand({ ip, port, command: 'Q' });
      await delay(BETWEEN_COMMAND_DELAY_MS);
      const status = await sendWsiCommand({ ip, port, command: 'E' });
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
    const { ip, port } = printerConfig(req.body);
    const { messageName, fieldName, fieldValue } = req.body;
    validateAscii(messageName, 'Message name', 30);
    validateAscii(fieldName, 'User field name', 30);
    validateAscii(fieldValue, 'User field value', 50);

    const { update, select, selected, status } = await runSequentially({ ip, port }, async () => {
      const update = await sendWsiCommand({ ip, port, command: `U${fieldName}\n${fieldValue}` });
      if (update.kind !== 'ack') throw new Error(`User-field update was not acknowledged: ${update.value}`);
      await delay(BETWEEN_COMMAND_DELAY_MS);

      const select = await sendWsiCommand({ ip, port, command: `M${messageName}` });
      if (select.kind !== 'ack') throw new Error(`Message selection was not acknowledged: ${select.value}`);
      await delay(BETWEEN_COMMAND_DELAY_MS);

      const selected = await sendWsiCommand({ ip, port, command: 'Q' });
      await delay(BETWEEN_COMMAND_DELAY_MS);
      const status = await sendWsiCommand({ ip, port, command: 'E' });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Videojet control running on http://localhost:${PORT}`);
  console.log(`Default printer: ${DEFAULT_PRINTER_IP}:${DEFAULT_PRINTER_PORT}`);
});

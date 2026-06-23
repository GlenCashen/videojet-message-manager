import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';
import { CoderQueue } from './server/coder-queue.js';
import { EmulatorManager } from './server/emulator-manager.js';
import { MessageUpdateError, executeMessageUpdate } from './server/message-store.js';
import { NgpclClient } from './server/ngpcl-client.js';
import { parseNgpclJobName } from './server/ngpcl-protocol.js';
import { withOperatorError } from './server/operator-error-messages.js';
import { printerCapabilities } from './server/printer-capabilities.js';
import { StatusCache } from './server/status-cache.js';
import { WsiClient } from './server/wsi-client.js';
import { validatePrinter } from './server/repositories/printer-repository.js';
import { assertPacketResponse } from './server/wsi-response.js';

const VERSION = '0.1.0';
const MAIN_SERVER_URL = String(process.env.MAIN_SERVER_URL || '').replace(/\/$/, '');
const AGENT_ID = String(process.env.PRINTER_AGENT_ID || '').trim();
const AGENT_TOKEN = String(process.env.PRINTER_AGENT_TOKEN || '');
const STATE_PATH = path.resolve(process.env.PRINTER_AGENT_STATE || 'data/printer-agent-state.json');
const POLL_MS = Math.max(Number(process.env.PRINTER_AGENT_POLL_MS || 500), 250);
const HEARTBEAT_MS = Math.max(Number(process.env.PRINTER_AGENT_HEARTBEAT_MS || 15000), 1000);
const CONFIG_REFRESH_MS = Math.max(Number(process.env.PRINTER_AGENT_CONFIG_REFRESH_MS || 30000), 1000);
const COMMAND_TIMEOUT_MS = Math.max(Number(process.env.COMMAND_TIMEOUT_MS || 5000), 500);
const BETWEEN_COMMAND_DELAY_MS = Math.max(Number(process.env.BETWEEN_COMMAND_DELAY_MS || 150), 0);
const TLS_CA_PATH = process.env.PRINTER_AGENT_CA_CERT || '';
const TLS_CERT_PATH = process.env.PRINTER_AGENT_CLIENT_CERT || '';
const TLS_KEY_PATH = process.env.PRINTER_AGENT_CLIENT_KEY || '';

if (!MAIN_SERVER_URL || !AGENT_ID || !AGENT_TOKEN) {
  throw new Error('MAIN_SERVER_URL, PRINTER_AGENT_ID and PRINTER_AGENT_TOKEN are required.');
}
if (!MAIN_SERVER_URL.startsWith('https://') && process.env.PRINTER_AGENT_ALLOW_HTTP !== 'true') {
  throw new Error('MAIN_SERVER_URL must use HTTPS unless PRINTER_AGENT_ALLOW_HTTP=true is explicitly set for development.');
}
if (Boolean(TLS_CERT_PATH) !== Boolean(TLS_KEY_PATH)) {
  throw new Error('PRINTER_AGENT_CLIENT_CERT and PRINTER_AGENT_CLIENT_KEY must be configured together.');
}

const tlsOptions = {
  ...(TLS_CA_PATH ? { ca: await fs.readFile(path.resolve(TLS_CA_PATH)) } : {}),
  ...(TLS_CERT_PATH ? { cert: await fs.readFile(path.resolve(TLS_CERT_PATH)) } : {}),
  ...(TLS_KEY_PATH ? { key: await fs.readFile(path.resolve(TLS_KEY_PATH)) } : {})
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wsiClient = new WsiClient({ timeoutMs: COMMAND_TIMEOUT_MS });
const ngpclClient = new NgpclClient({ timeoutMs: COMMAND_TIMEOUT_MS });
const queue = new CoderQueue();
const statusCache = new StatusCache();
const emulatorManager = new EmulatorManager({
  delay,
  onError: (message) => console.error(message)
});
let stopping = false;
let lastHeartbeatAt = 0;
let lastConfigAt = 0;
let activePrinters = [];

function printerProtocol(printer) {
  return printer.protocol || 'wsi';
}

function clientForPrinter(printer) {
  return printerProtocol(printer) === 'ngpcl' ? ngpclClient : wsiClient;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function refreshPrinters({ force = false } = {}) {
  if (!force && activePrinters.length && Date.now() - lastConfigAt < CONFIG_REFRESH_MS) return activePrinters;
  try {
    const data = await request('/api/printer-agent/v1/config');
    const printers = (Array.isArray(data?.printers) ? data.printers : []).map(validatePrinter);
    if (!printers.length) throw new Error('Main server returned no assigned printers for this agent.');
    activePrinters = printers;
    lastConfigAt = Date.now();
    await emulatorManager.sync(activePrinters);
    return activePrinters;
  } catch (error) {
    if (!activePrinters.length) throw error;
    console.error(`${new Date().toISOString()} Could not refresh printer config: ${error.message}`);
    return activePrinters;
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, STATE_PATH);
}

async function request(endpoint, options = {}) {
  const url = new URL(`${MAIN_SERVER_URL}${endpoint}`);
  const body = options.body || '';
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: options.method || 'GET',
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-printer-agent-id': AGENT_ID,
        ...(options.headers || {})
      },
      timeout: 15000,
      ...tlsOptions
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode === 204) return resolve(null);
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = {}; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(data.error || `Main server returned HTTP ${response.statusCode}.`));
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Main server request timed out.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function report(job, result) {
  await request(`/api/printer-agent/v1/jobs/${encodeURIComponent(job.id)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ payloadHash: job.payloadHash, result })
  });
}

async function recoverInterrupted(state) {
  if (!state.active) return;
  const { job, pendingResult } = state.active;
  const result = pendingResult || {
    ok: false,
    code: 'AGENT_RESTARTED_DURING_SEND',
    printerId: job.payload.printerId,
    error: 'Printer agent restarted while this job was in flight. Confirm physical printer state before retrying.',
    checkedAt: new Date().toISOString()
  };
  await report(job, withOperatorError(result));
  await writeState({ active: null });
}

async function execute(job, printers) {
  if (payloadHash(job.payload) !== job.payloadHash) throw new Error('Claimed job payload hash verification failed.');
  if (job.payload.protocolVersion !== 1) throw new Error(`Unsupported printer job protocol ${job.payload.protocolVersion}.`);
  const printer = printers.find((item) => item.id === job.payload.printerId && item.enabled);
  if (!printer) throw new Error(`Printer ${job.payload.printerId} is not enabled in the server-assigned agent configuration.`);
  const message = job.payload.message;
  if (printer.mode === 'emulator') {
    emulatorManager.configurePrinter(printer.id, {
      messageNames: [message.printerMessageName],
      fieldNames: (message.fields || []).map((field) => field.printerFieldName)
    });
  }
  const capabilities = printerCapabilities(printer.model, printer.readbackMode, printer.protocol);
  const client = clientForPrinter(printer);
  const result = await queue.run(printer.id, { operation: 'release-apply', jobId: job.id }, () => executeMessageUpdate({
    printer,
    target: { ip: printer.host, port: printer.port },
    message,
    fields: job.payload.fields || {},
    operationId: job.id,
    productionDate: job.payload.plannedProductionAt,
    supportsCurrentMessageReadback: capabilities.currentMessageReadback === true,
    sendCommand: (command) => client.sendCommand(command),
    delay: () => delay(BETWEEN_COMMAND_DELAY_MS),
    applySuccess: (status) => statusCache.applySuccess(printer.id, status)
  }));
  if (result.expectedOutput?.rendered !== job.payload.expectedRendered) {
    const error = new Error('Locally rendered printer output does not match the approved job payload.');
    error.code = 'AGENT_OUTPUT_MISMATCH';
    throw error;
  }
  return result;
}

function failureResult(error, job) {
  if (error instanceof MessageUpdateError && error.result) {
    return withOperatorError({ ...error.result, ok: false, error: error.result.error || error.message });
  }
  return withOperatorError({
    ok: false,
    code: error.code || 'AGENT_EXECUTION_FAILED',
    printerId: job.payload.printerId,
    error: error.message,
    checkedAt: new Date().toISOString()
  });
}

async function pollPrinterStatus(printer) {
  const startedAt = Date.now();
  try {
    const target = { printerId: printer.id, ip: printer.host, port: printer.port };
    const protocol = printerProtocol(printer);
    const capabilities = printerCapabilities(printer.model, printer.readbackMode, protocol);
    const client = clientForPrinter(printer);
    let selectedMessage;
    if (protocol === 'ngpcl') {
      const rawMessage = await client.sendCommand({ ...target, protocol, command: '{~JR|}' });
      selectedMessage = parseNgpclJobName(rawMessage);
      if (BETWEEN_COMMAND_DELAY_MS > 0) await delay(BETWEEN_COMMAND_DELAY_MS);
    } else if (capabilities.currentMessageReadback) {
      selectedMessage = assertPacketResponse('Q', await wsiClient.sendCommand({ ...target, command: 'Q' })).value.trim();
      if (BETWEEN_COMMAND_DELAY_MS > 0) await delay(BETWEEN_COMMAND_DELAY_MS);
    }
    const rawStatus = protocol === 'ngpcl'
      ? (await client.sendCommand({ ...target, protocol, command: '{~DR|}' })).value
      : assertPacketResponse('E', await wsiClient.sendCommand({ ...target, command: 'E' })).value;
    return statusCache.applySuccess(printer.id, {
      ...(selectedMessage !== undefined ? { selectedMessage } : {}),
      messageVerification: capabilities.currentMessageReadback ? 'verified' : 'unsupported',
      rawStatus,
      protocol,
      responseTimeMs: Date.now() - startedAt
    });
  } catch (error) {
    return statusCache.applyFailure(printer.id, error);
  }
}

async function heartbeat(printers) {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_MS) return;
  const statuses = [];
  for (const printer of printers.filter((item) => item.enabled)) {
    statuses.push(await pollPrinterStatus(printer));
  }
  await request('/api/printer-agent/v1/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ version: VERSION, hostname: os.hostname(), statuses })
  });
  lastHeartbeatAt = Date.now();
}

async function main() {
  let printers = await refreshPrinters({ force: true });
  await recoverInterrupted(await readJson(STATE_PATH, { active: null }));
  console.log(`Printer agent ${AGENT_ID} started with ${printers.length} server-assigned printer(s).`);

  while (!stopping) {
    try {
      printers = await refreshPrinters();
      await recoverInterrupted(await readJson(STATE_PATH, { active: null }));
      const claimed = await request('/api/printer-agent/v1/jobs/claim', { method: 'POST', body: '{}' });
      if (!claimed?.job) {
        await heartbeat(printers);
        await delay(POLL_MS);
        continue;
      }
      const job = claimed.job;
      await writeState({ active: { job, pendingResult: null } });
      let result;
      try {
        result = await execute(job, printers);
      } catch (error) {
        result = failureResult(error, job);
      }
      await writeState({ active: { job, pendingResult: result } });
      await report(job, result);
      await writeState({ active: null });
      await heartbeat(printers);
    } catch (error) {
      console.error(`${new Date().toISOString()} ${error.message}`);
      await delay(POLL_MS);
    }
  }
  await emulatorManager.close();
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

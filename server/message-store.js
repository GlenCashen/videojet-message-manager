import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MESSAGES_PATH = path.join(__dirname, '..', 'data', 'messages.json');
const DEFAULT_DATE_FORMAT = 'DD/MM/YYYY';
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
const MESSAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PRINTER_FIELD_PATTERN = /^[A-Z0-9 _-]{1,30}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/;

class MessageUpdateError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'MessageUpdateError';
    this.result = result;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function validateDefinition(definition, index) {
  assertObject(definition, `Message at index ${index}`);
  assertString(definition.id, `Message ${index} id`);
  assertString(definition.displayName, `Message ${definition.id} displayName`);
  assertString(definition.printerMessageName, `Message ${definition.id} printerMessageName`);

  if (!MESSAGE_ID_PATTERN.test(definition.id)) {
    throw new Error(`Message id ${definition.id} is invalid.`);
  }
  if (!PRINTABLE_ASCII_PATTERN.test(definition.printerMessageName) || definition.printerMessageName.length > 30) {
    throw new Error(`Message ${definition.id} printerMessageName must be printable ASCII up to 30 characters.`);
  }
  if (typeof definition.enabled !== 'boolean') {
    throw new Error(`Message ${definition.id} enabled must be boolean.`);
  }
  if (!Array.isArray(definition.fields) || !definition.fields.length) {
    throw new Error(`Message ${definition.id} must define at least one field.`);
  }

  const fieldKeys = new Set();
  const printerFieldNames = new Set();
  for (const field of definition.fields) {
    assertObject(field, `Message ${definition.id} field`);
    assertString(field.key, `Message ${definition.id} field key`);
    assertString(field.label, `Message ${definition.id} field ${field.key} label`);
    assertString(field.printerFieldName, `Message ${definition.id} field ${field.key} printerFieldName`);

    if (!FIELD_KEY_PATTERN.test(field.key)) throw new Error(`Field key ${field.key} is invalid.`);
    if (!PRINTER_FIELD_PATTERN.test(field.printerFieldName)) {
      throw new Error(`Printer field name ${field.printerFieldName} is invalid.`);
    }
    if (fieldKeys.has(field.key)) throw new Error(`Duplicate field key ${field.key} in message ${definition.id}.`);
    if (printerFieldNames.has(field.printerFieldName)) {
      throw new Error(`Duplicate printer field name ${field.printerFieldName} in message ${definition.id}.`);
    }
    if (field.required !== true) throw new Error(`Field ${field.key} must be required in this release.`);
    if (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 50) {
      throw new Error(`Field ${field.key} maxLength must be 1-50.`);
    }
    fieldKeys.add(field.key);
    printerFieldNames.add(field.printerFieldName);
  }

  assertObject(definition.dateRule, `Message ${definition.id} dateRule`);
  if (definition.dateRule.type !== 'offset-months') {
    throw new Error(`Message ${definition.id} dateRule.type must be offset-months.`);
  }
  if (!Number.isInteger(definition.dateRule.months) || definition.dateRule.months <= 0) {
    throw new Error(`Message ${definition.id} dateRule.months must be a positive integer.`);
  }
  if (!Array.isArray(definition.previewLines) || !definition.previewLines.length) {
    throw new Error(`Message ${definition.id} previewLines must be a non-empty array.`);
  }
  for (const line of definition.previewLines) assertString(line, `Message ${definition.id} preview line`);
}

function validateMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('messages.json must contain an array.');

  const ids = new Set();
  const printerNames = new Set();
  for (const [index, definition] of messages.entries()) {
    validateDefinition(definition, index);
    if (ids.has(definition.id)) throw new Error(`Duplicate message id ${definition.id}.`);
    if (printerNames.has(definition.printerMessageName)) {
      throw new Error(`Duplicate printer message name ${definition.printerMessageName}.`);
    }
    ids.add(definition.id);
    printerNames.add(definition.printerMessageName);
  }

  return clone(messages);
}

async function loadMessages(filePath = DEFAULT_MESSAGES_PATH) {
  const raw = await fs.readFile(filePath, 'utf8');
  return validateMessages(JSON.parse(raw));
}

function enabledMessages(messages) {
  return clone(messages.filter((message) => message.enabled));
}

function getMessageById(messages, id) {
  const message = messages.find((item) => item.id === id);
  if (!message) throw new Error(`Message ${id} was not found.`);
  return clone(message);
}

function validateMessageFields(message, fields = {}) {
  assertObject(fields, 'fields');

  const allowed = new Set(message.fields.map((field) => field.key));
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new Error(`Unknown field ${key}.`);
  }

  const normalized = {};
  for (const field of message.fields) {
    const value = fields[field.key];
    if (field.required && (typeof value !== 'string' || !value.trim())) {
      throw new Error(`${field.label} is required.`);
    }
    if (typeof value !== 'string') throw new Error(`${field.label} must be a string.`);
    if (value.length > field.maxLength) throw new Error(`${field.label} must be ${field.maxLength} characters or fewer.`);
    if (!PRINTABLE_ASCII_PATTERN.test(value)) throw new Error(`${field.label} must contain printable ASCII characters only.`);
    normalized[field.key] = value.trim();
  }

  return normalized;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function parseProductionDate(value) {
  if (!value) {
    const now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds()
    };
  }

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) throw new Error('productionDate must be an ISO timestamp.');

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6])
  };
}

function addCalendarMonthsClamped(parts, months) {
  const targetIndex = parts.month - 1 + months;
  const year = parts.year + Math.floor(targetIndex / 12);
  const month = (targetIndex % 12 + 12) % 12 + 1;
  // Add calendar months, then clamp month-end dates to the target month's last day.
  const day = Math.min(parts.day, daysInMonth(year, month));
  return { year, month, day };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateParts(parts, format = DEFAULT_DATE_FORMAT) {
  if (format !== DEFAULT_DATE_FORMAT) throw new Error(`Unsupported date format ${format}.`);
  return `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}`;
}

function renderPreview(message, fields, options = {}) {
  const normalized = validateMessageFields(message, fields);
  const production = parseProductionDate(options.productionDate);
  const bestBefore = addCalendarMonthsClamped(production, message.dateRule.months);
  const tokens = {
    ...normalized,
    bestBeforeDate: formatDateParts(bestBefore, options.dateFormat || DEFAULT_DATE_FORMAT),
    currentTime: `${pad2(production.hour)}:${pad2(production.minute)}:${pad2(production.second)}`
  };

  const lines = message.previewLines.map((line) =>
    line.replace(/\{\{([a-zA-Z0-9-]+)\}\}/g, (_match, key) => tokens[key] ?? '')
  );

  return {
    messageId: message.id,
    printerMessageName: message.printerMessageName,
    fields: normalized,
    bestBeforeDate: tokens.bestBeforeDate,
    currentTime: tokens.currentTime,
    lines,
    rendered: lines.join('\n')
  };
}

function failureResult(base, fieldResults, messageSelection, extra = {}) {
  return {
    ...base,
    ok: false,
    online: false,
    messageMatches: false,
    fieldResults,
    messageSelection,
    ...extra
  };
}

async function executeMessageUpdate({
  printer,
  target,
  message,
  fields,
  operationId,
  sendCommand,
  delay = async () => {},
  applySuccess,
  productionDate,
  now = () => Date.now()
}) {
  const startedAt = now();
  const normalized = validateMessageFields(message, fields);
  const expectedOutput = renderPreview(message, normalized, { productionDate });
  const fieldResults = [];
  const base = {
    id: printer.id,
    printerId: printer.id,
    operationId,
    name: printer.name,
    location: printer.location,
    host: printer.host,
    port: printer.port,
    targetHost: target.ip,
    targetPort: target.port,
    mode: printer.mode,
    enabled: printer.enabled,
    requestedMessage: message.printerMessageName,
    expectedMessage: message.printerMessageName,
    expectedOutput: { lines: expectedOutput.lines, rendered: expectedOutput.rendered }
  };

  for (const field of message.fields) {
    try {
      const update = await sendCommand({ printerId: printer.id, ...target, command: `U${field.printerFieldName}\n${normalized[field.key]}` });
      const acknowledged = update.kind === 'ack';
      fieldResults.push({ key: field.key, printerFieldName: field.printerFieldName, acknowledged });
      if (!acknowledged) {
        throw new MessageUpdateError('Message update failed', failureResult(base, fieldResults, 'Not attempted', {
          error: `${field.printerFieldName} update was not acknowledged.`,
          failedField: field.key
        }));
      }
    } catch (error) {
      if (error instanceof MessageUpdateError) throw error;
      fieldResults.push({ key: field.key, printerFieldName: field.printerFieldName, acknowledged: false });
      throw new MessageUpdateError('Message update failed', failureResult(base, fieldResults, 'Not attempted', {
        error: error.message,
        failedField: field.key
      }));
    }
    await delay();
  }

  const select = await sendCommand({ printerId: printer.id, ...target, command: `M${message.printerMessageName}` });
  if (select.kind !== 'ack') {
    throw new MessageUpdateError('Message selection was not acknowledged.', failureResult(base, fieldResults, 'Failed', {
      error: `Message selection was not acknowledged: ${select.value}`
    }));
  }
  await delay();

  const selected = await sendCommand({ printerId: printer.id, ...target, command: 'Q' });
  await delay();
  const status = await sendCommand({ printerId: printer.id, ...target, command: 'E' });
  const elapsedMs = now() - startedAt;
  const cached = applySuccess({
    selectedMessage: selected.value,
    rawStatus: status.value,
    responseTimeMs: elapsedMs
  });
  const messageMatches = selected.value === message.printerMessageName;

  return {
    ...cached,
    ...base,
    online: true,
    ok: messageMatches,
    messageMatches,
    selectedMessage: selected.value,
    fieldResults,
    messageSelection: 'Acknowledged',
    status: status.value,
    rawStatus: status.value,
    checkedAt: cached.lastSuccessfulAt,
    elapsedMs
  };
}

export {
  DEFAULT_DATE_FORMAT,
  MessageUpdateError,
  addCalendarMonthsClamped,
  enabledMessages,
  executeMessageUpdate,
  getMessageById,
  loadMessages,
  renderPreview,
  validateMessageFields,
  validateMessages
};

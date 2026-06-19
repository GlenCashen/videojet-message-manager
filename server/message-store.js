import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMessages, replaceMessages } from './repositories/message-repository.js';
import { assertPacketResponse, failureMessage } from './wsi-response.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MESSAGES_PATH = path.join(__dirname, '..', 'data', 'messages.json');
const DEFAULT_DATE_FORMAT = 'DD/MM/YYYY';
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
const MESSAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PRINTER_FIELD_PATTERN = /^[A-Z0-9 _-]{1,30}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/;

class MessageUpdateError extends Error {
  constructor(message, result, options = {}) {
    super(message);
    this.name = 'MessageUpdateError';
    this.result = result;
    this.code = options.code || result?.code || 'MESSAGE_UPDATE_FAILED';
    this.communicationSucceeded = options.communicationSucceeded ?? result?.communicationSucceeded ?? true;
    this.refreshError = options.refreshError || null;
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

function normalizeTransform(transform) {
  if (transform === undefined || transform === null || transform === '') return 'uppercase';
  if (transform === 'uppercase' || transform === 'none') return transform;
  throw new Error(`Unsupported field transform ${transform}.`);
}

function validateAssignment(messageId, assignment, index, printerIds) {
  assertObject(assignment, `Message ${messageId} assignment ${index}`);
  assertString(assignment.printerId, `Message ${messageId} assignment printerId`);
  assertString(assignment.printerMessageName, `Message ${messageId} assignment printerMessageName`);
  if (typeof assignment.enabled !== 'boolean') {
    throw new Error(`Message ${messageId} assignment enabled must be boolean.`);
  }
  if (!PRINTABLE_ASCII_PATTERN.test(assignment.printerMessageName) || assignment.printerMessageName.length > 30) {
    throw new Error(`Message ${messageId} assignment printerMessageName must be printable ASCII up to 30 characters.`);
  }
  if (printerIds && !printerIds.has(assignment.printerId)) {
    throw new Error(`Message ${messageId} is assigned to unknown printer ${assignment.printerId}.`);
  }
}

function validateDefinition(definition, index, printerIds) {
  assertObject(definition, `Message at index ${index}`);
  assertString(definition.id, `Message ${index} id`);
  assertString(definition.displayName, `Message ${definition.id} displayName`);

  if (!MESSAGE_ID_PATTERN.test(definition.id)) {
    throw new Error(`Message id ${definition.id} is invalid.`);
  }
  if (typeof definition.enabled !== 'boolean') {
    throw new Error(`Message ${definition.id} enabled must be boolean.`);
  }
  if (!Array.isArray(definition.fields)) {
    throw new Error(`Message ${definition.id} fields must be an array.`);
  }

  if (!Array.isArray(definition.printerAssignments)) {
    if (!definition.printerMessageName) {
      throw new Error(`Message ${definition.id} must define printerAssignments.`);
    }
    definition.printerAssignments = [
      { printerId: '*', printerMessageName: definition.printerMessageName, enabled: true }
    ];
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
    field.transform = normalizeTransform(field.transform);
    fieldKeys.add(field.key);
    printerFieldNames.add(field.printerFieldName);
  }

  const assignmentPrinterIds = new Set();
  for (const [assignmentIndex, assignment] of definition.printerAssignments.entries()) {
    validateAssignment(definition.id, assignment, assignmentIndex, printerIds);
    if (assignmentPrinterIds.has(assignment.printerId)) {
      throw new Error(`Duplicate assignment for printer ${assignment.printerId} in message ${definition.id}.`);
    }
    assignmentPrinterIds.add(assignment.printerId);
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

function validateMessages(messages, options = {}) {
  if (!Array.isArray(messages)) throw new Error('messages.json must contain an array.');

  const ids = new Set();
  const printerIds = options.printers ? new Set(options.printers.map((printer) => printer.id)) : null;
  for (const [index, definition] of messages.entries()) {
    validateDefinition(definition, index, printerIds);
    if (ids.has(definition.id)) throw new Error(`Duplicate message id ${definition.id}.`);
    ids.add(definition.id);
  }

  return clone(messages);
}

async function loadMessages(filePath = DEFAULT_MESSAGES_PATH, options = {}) {
  if (filePath === DEFAULT_MESSAGES_PATH) {
    return validateMessages(listMessages(), options);
  }
  const raw = await fs.readFile(filePath, 'utf8');
  return validateMessages(JSON.parse(raw), options);
}

async function saveMessages(messages, filePath = DEFAULT_MESSAGES_PATH, options = {}) {
  const validated = validateMessages(messages, options);
  if (filePath === DEFAULT_MESSAGES_PATH) {
    return replaceMessages(validated);
  }
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.messages-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
  return validated;
}

function enabledMessages(messages) {
  return clone(messages.filter((message) => message.enabled));
}

function messageForAssignment(message, assignment) {
  return {
    ...clone(message),
    printerMessageName: assignment.printerMessageName,
    assignment: clone(assignment)
  };
}

function messagesForPrinter(messages, printerId) {
  return messages
    .filter((message) => message.enabled)
    .map((message) => {
      const assignment = (message.printerAssignments || []).find((item) =>
        item.enabled && (item.printerId === printerId || item.printerId === '*')
      );
      return assignment ? messageForAssignment(message, assignment) : null;
    })
    .filter(Boolean);
}

function getMessageForPrinter(messages, id, printerId) {
  const message = getMessageById(messages, id);
  const assignment = (message.printerAssignments || []).find((item) =>
    item.enabled && (item.printerId === printerId || item.printerId === '*')
  );
  if (!assignment) {
    const error = new Error(`Message ${id} is not assigned to printer ${printerId}.`);
    error.statusCode = 403;
    throw error;
  }
  return messageForAssignment(message, assignment);
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
    const trimmed = value.trim();
    const transformed = normalizeTransform(field.transform) === 'uppercase' ? trimmed.toUpperCase() : trimmed;
    if (transformed.length > field.maxLength) throw new Error(`${field.label} must be ${field.maxLength} characters or fewer.`);
    if (!PRINTABLE_ASCII_PATTERN.test(transformed)) throw new Error(`${field.label} must contain printable ASCII characters only.`);
    normalized[field.key] = transformed;
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
    displayName: message.displayName,
    printerMessageName: message.printerMessageName,
    fields: normalized,
    bestBeforeDate: tokens.bestBeforeDate,
    currentTime: tokens.currentTime,
    lines,
    rendered: lines.join('\n')
  };
}

function statusResult(cached) {
  if (!cached) return null;
  return {
    online: cached.online,
    stale: cached.stale,
    selectedMessage: cached.selectedMessage,
    rawStatus: cached.rawStatus,
    decodedStatus: cached.decodedStatus,
    expectedOutput: cached.expectedOutput,
    lastSuccessfulAt: cached.lastSuccessfulAt,
    consecutiveFailures: cached.consecutiveFailures,
    lastError: cached.lastError
  };
}

function failureResult(base, fieldResults, messageSelection, extra = {}) {
  return {
    ...base,
    ok: false,
    communicationSucceeded: true,
    printerOnline: true,
    messageMatches: false,
    fieldResults,
    failedStep: extra.failedStep || 'message-update',
    messageSelection,
    messageSelectionAttempted: messageSelection !== 'Not attempted',
    ...extra
  };
}

function transportFailureCode(error) {
  if (error?.code === 'WSI_TIMEOUT') return 'WSI_TIMEOUT';
  if (error?.code === 'WSI_PROTOCOL_ERROR') return 'WSI_PROTOCOL_ERROR';
  return 'WSI_CONNECTION_ERROR';
}

async function refreshStateAfterRejection({
  base,
  fieldResults,
  messageSelection,
  failedStep,
  code,
  error,
  printer,
  target,
  sendCommand,
  delay,
  applySuccess,
  now,
  startedAt,
  supportsCurrentMessageReadback = true
}) {
  try {
    const selected = supportsCurrentMessageReadback
      ? assertPacketResponse('Q', await sendCommand({ printerId: printer.id, ...target, command: 'Q' }))
      : null;
    if (selected) await delay();
    const status = assertPacketResponse('E', await sendCommand({ printerId: printer.id, ...target, command: 'E' }));
    const cached = applySuccess({
      ...(selected ? { selectedMessage: selected.value } : {}),
      messageVerification: supportsCurrentMessageReadback ? 'verified' : 'unsupported',
      rawStatus: status.value,
      responseTimeMs: now() - startedAt
    });
    const result = failureResult(base, fieldResults, messageSelection, {
      code,
      error,
      failedStep,
      selectedMessage: selected?.value || null,
      rawStatus: status.value,
      status: statusResult(cached)
    });
    throw new MessageUpdateError('Message update failed', result, { code, communicationSucceeded: true });
  } catch (refreshError) {
    if (refreshError instanceof MessageUpdateError) throw refreshError;
    const result = failureResult(base, fieldResults, messageSelection, {
      code,
      error,
      failedStep,
      refreshError: refreshError.message,
      communicationSucceeded: false,
      printerOnline: null
    });
    throw new MessageUpdateError('Message update failed', result, {
      code,
      communicationSucceeded: false,
      refreshError
    });
  }
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
  supportsCurrentMessageReadback = true,
  now = () => Date.now()
}) {
  const startedAt = now();
  const normalized = validateMessageFields(message, fields);
  const preview = renderPreview(message, normalized, { productionDate });
  const expectedOutput = {
    messageId: message.id,
    displayName: message.displayName,
    printerMessageName: message.printerMessageName,
    fields: normalized,
    lines: preview.lines,
    rendered: preview.rendered,
    generatedAt: new Date(startedAt).toISOString(),
    source: 'last-applied'
  };
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
    model: printer.model || '1620',
    enabled: printer.enabled,
    requestedMessage: message.printerMessageName,
    expectedMessage: message.printerMessageName,
    expectedOutput,
    verificationAvailable: supportsCurrentMessageReadback
  };

  for (const field of message.fields) {
    try {
      const update = await sendCommand({ printerId: printer.id, ...target, command: `U${field.printerFieldName}\n${normalized[field.key]}` });
      if (update.kind !== 'ack') {
        const command = `U${field.printerFieldName}\n${normalized[field.key]}`;
        const rejectionError = failureMessage(command, update);
        if (update.kind === 'nack') {
          fieldResults.push({
            key: field.key,
            printerFieldName: field.printerFieldName,
            acknowledged: false,
            error: rejectionError
          });
          await refreshStateAfterRejection({
            base,
            fieldResults,
            messageSelection: 'Not attempted',
            failedStep: 'field-update',
            code: 'FIELD_UPDATE_REJECTED',
            error: rejectionError,
            printer,
            target,
            sendCommand,
            delay,
            applySuccess,
            now,
            startedAt,
            supportsCurrentMessageReadback
          });
        }
        fieldResults.push({
          key: field.key,
          printerFieldName: field.printerFieldName,
          acknowledged: false,
          error: `Unexpected WSI response: ${update.value}`
        });
        throw new MessageUpdateError('WSI protocol error', failureResult(base, fieldResults, 'Not attempted', {
          code: 'WSI_PROTOCOL_ERROR',
          communicationSucceeded: false,
          printerOnline: null,
          error: `Unexpected WSI response: ${update.value}`,
          failedField: field.key,
          failedStep: 'field-update'
        }), { code: 'WSI_PROTOCOL_ERROR', communicationSucceeded: false });
      }
      fieldResults.push({ key: field.key, printerFieldName: field.printerFieldName, acknowledged: true });
    } catch (error) {
      if (error instanceof MessageUpdateError) throw error;
      fieldResults.push({
        key: field.key,
        printerFieldName: field.printerFieldName,
        acknowledged: false,
        error: error.message
      });
      const code = transportFailureCode(error);
      throw new MessageUpdateError('Message update failed', failureResult(base, fieldResults, 'Not attempted', {
        code,
        communicationSucceeded: false,
        printerOnline: null,
        error: error.message,
        failedField: field.key,
        failedStep: 'field-update'
      }), { code, communicationSucceeded: false });
    }
    await delay();
  }

  let select;
  try {
    select = await sendCommand({ printerId: printer.id, ...target, command: `M${message.printerMessageName}` });
  } catch (error) {
    const code = transportFailureCode(error);
    throw new MessageUpdateError('Message selection failed', failureResult(base, fieldResults, 'Failed', {
      code,
      communicationSucceeded: false,
      printerOnline: null,
      error: error.message,
      failedStep: 'message-selection'
    }), { code, communicationSucceeded: false });
  }
  if (select.kind !== 'ack') {
    const rejectionError = failureMessage(`M${message.printerMessageName}`, select);
    if (select.kind === 'nack') {
      await refreshStateAfterRejection({
        base,
        fieldResults,
        messageSelection: 'Failed',
        failedStep: 'message-selection',
        code: 'MESSAGE_SELECTION_REJECTED',
        error: rejectionError,
        printer,
        target,
        sendCommand,
        delay,
        applySuccess,
        now,
        startedAt,
        supportsCurrentMessageReadback
      });
    }
    throw new MessageUpdateError('Message selection was not acknowledged.', failureResult(base, fieldResults, 'Failed', {
      code: 'WSI_PROTOCOL_ERROR',
      communicationSucceeded: false,
      printerOnline: null,
      error: rejectionError,
      failedStep: 'message-selection'
    }), { code: 'WSI_PROTOCOL_ERROR', communicationSucceeded: false });
  }
  await delay();

  let selected;
  let status;
  try {
    selected = supportsCurrentMessageReadback
      ? assertPacketResponse('Q', await sendCommand({ printerId: printer.id, ...target, command: 'Q' }))
      : null;
    if (selected) await delay();
    status = assertPacketResponse('E', await sendCommand({ printerId: printer.id, ...target, command: 'E' }));
  } catch (error) {
    const code = transportFailureCode(error);
    throw new MessageUpdateError('Message verification failed', failureResult(base, fieldResults, 'Acknowledged', {
      code,
      communicationSucceeded: false,
      printerOnline: null,
      error: error.message,
      failedStep: 'verification'
    }), { code, communicationSucceeded: false });
  }
  const elapsedMs = now() - startedAt;
  const cached = applySuccess({
    ...(selected ? { selectedMessage: selected.value } : {}),
    messageVerification: supportsCurrentMessageReadback ? 'verified' : 'unsupported',
    rawStatus: status.value,
    responseTimeMs: elapsedMs,
    expectedOutput
  });
  const messageMatches = selected ? selected.value === message.printerMessageName : null;

  return {
    ...cached,
    ...base,
    online: true,
    ok: messageMatches !== false,
    code: messageMatches === false ? 'MESSAGE_MISMATCH' : undefined,
    communicationSucceeded: true,
    printerOnline: true,
    messageMatches,
    verificationAvailable: supportsCurrentMessageReadback,
    selectedMessage: selected?.value || null,
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
  getMessageForPrinter,
  getMessageById,
  loadMessages,
  messagesForPrinter,
  renderPreview,
  saveMessages,
  validateMessageFields,
  validateMessages
};

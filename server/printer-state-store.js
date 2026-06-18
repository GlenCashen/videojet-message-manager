import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listExpectedOutputs, upsertExpectedOutput } from './repositories/expected-output-repository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_STATE_PATH = path.join(__dirname, '..', 'data', 'printer-state.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateExpectedOutput(record, printerId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Printer state for ${printerId} must be an object.`);
  }

  const requiredStrings = ['messageId', 'displayName', 'printerMessageName', 'rendered', 'appliedAt'];
  for (const key of requiredStrings) {
    if (typeof record[key] !== 'string' || !record[key]) {
      throw new Error(`Printer state for ${printerId} must include ${key}.`);
    }
  }

  if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
    throw new Error(`Printer state for ${printerId} fields must be an object.`);
  }
  if (!Array.isArray(record.lines) || record.lines.some((line) => typeof line !== 'string')) {
    throw new Error(`Printer state for ${printerId} lines must be an array of strings.`);
  }

  return clone(record);
}

async function loadPrinterState(filePath = DEFAULT_STATE_PATH) {
  if (filePath === DEFAULT_STATE_PATH) return listExpectedOutputs();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('printer-state.json must contain an object.');
    }

    const records = {};
    for (const [printerId, record] of Object.entries(parsed)) {
      records[printerId] = validateExpectedOutput(record, printerId);
    }
    return records;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function savePrinterState(records, filePath = DEFAULT_STATE_PATH) {
  if (filePath === DEFAULT_STATE_PATH) {
    for (const [printerId, record] of Object.entries(records || {})) upsertExpectedOutput(printerId, record);
    return;
  }
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.printer-state-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function persistedRecordFromExpected(expectedOutput) {
  return {
    messageId: expectedOutput.messageId,
    displayName: expectedOutput.displayName,
    printerMessageName: expectedOutput.printerMessageName,
    fields: clone(expectedOutput.fields || {}),
    lines: clone(expectedOutput.lines || []),
    rendered: expectedOutput.rendered || '',
    appliedAt: expectedOutput.generatedAt || expectedOutput.appliedAt
  };
}

function restoredExpectedOutput(record) {
  return {
    messageId: record.messageId,
    displayName: record.displayName,
    printerMessageName: record.printerMessageName,
    fields: clone(record.fields),
    lines: clone(record.lines),
    rendered: record.rendered,
    generatedAt: record.appliedAt,
    source: 'last-known'
  };
}

export {
  DEFAULT_STATE_PATH,
  loadPrinterState,
  persistedRecordFromExpected,
  restoredExpectedOutput,
  savePrinterState
};

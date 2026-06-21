import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { getDb } from './db.js';
import { validateMessages } from './message-store.js';
import { upsertMessage } from './repositories/message-repository.js';
import { resolveMessageUserFields } from './repositories/printer-user-field-repository.js';
import {
  createProductMaster,
  listProductMasters,
  normalizeSpecification,
  updateProductMaster
} from './repositories/product-master-repository.js';

const DEFAULT_PRINTER_NAMES = {
  cans: 'Can Coder',
  bottles: 'Bottle Coder',
  case: 'Case Coder'
};

const FIELD_DEFINITIONS = {
  run: {
    key: 'run', label: 'Run code', printerFieldName: 'RUN', required: true, maxLength: 10, transform: 'uppercase'
  },
  batch: {
    key: 'batch', label: 'Batch code', printerFieldName: 'BATCH', required: true, maxLength: 50, transform: 'uppercase'
  }
};

const FIELD_SOURCES = {
  run: 'run_code',
  batch: 'brew_sheet_product'
};

function normalizeWhitespace(value) {
  return String(value || '').replace(/[\u00a0\s]+/g, ' ').trim();
}

function normalizeTemplate(value) {
  let template = normalizeWhitespace(value);
  if (!template) return '';
  template = template.replace(/\s*\([^)]*(?:DD\/MM\/YYYY|HH:MM:SS)[^)]*\)/gi, '');
  template = template
    .replace(/<\s*TXXXX\s*>/gi, '{{run}}')
    .replace(/<\s*batch\s+code\s*>/gi, '{{batch}}')
    .replace(/<\s*date\s*>/gi, '{{bestBeforeDate}}')
    .replace(/<\s*time2?\s*>/gi, '{{currentTime}}');
  template = normalizeWhitespace(template);
  if (/<[^>]+>/.test(template)) throw new Error(`Unsupported catalog placeholder in "${value}".`);
  return template;
}

function parseMonths(row) {
  const raw = String(row.bestBeforeMonths || '').trim();
  if (raw !== '') {
    const months = Number(raw);
    if (Number.isInteger(months) && months >= 0 && months <= 120) return months;
    throw new Error(`Invalid best-before months for SKU ${row.sku}: ${raw}.`);
  }
  const templates = [
    row.primaryLine1, row.primaryLine2, row.primaryLine3,
    row.secondaryLine1, row.secondaryLine2, row.secondaryLine3
  ].join(' ');
  if (/best\s+after/i.test(templates)) return 0;
  throw new Error(`SKU ${row.sku} has coding instructions but no best-before rule.`);
}

function fieldsForLines(lines) {
  const joined = lines.join('\n');
  return Object.keys(FIELD_DEFINITIONS)
    .filter((key) => joined.includes(`{{${key}}}`))
    .sort((a, b) => joined.indexOf(`{{${a}}}`) - joined.indexOf(`{{${b}}}`));
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function printerCode(role) {
  if (role === 'cans') return 'CAN';
  if (role === 'bottles') return 'BTL';
  return 'CASE';
}

function buildMessage({ role, printerId, months, lines }) {
  const fieldKeys = fieldsForLines(lines);
  const signature = JSON.stringify({ printerId, months, lines, fieldKeys });
  const hash = shortHash(signature);
  const monthLabel = months === 0 ? 'NOW' : `${months}M`;
  const code = printerCode(role);
  const descriptors = fieldKeys.length
    ? fieldKeys.map((key) => key.toUpperCase())
    : [lines.some((line) => line.includes('{{bestBeforeDate}}')) ? 'DATE' : '', lines.some((line) => line.includes('{{currentTime}}')) ? 'TIME' : ''].filter(Boolean);
  return {
    id: `catalog-${role}-${monthLabel.toLowerCase()}-${hash}`,
    displayName: `${monthLabel} ${lines.length} line ${descriptors.join('/') || 'STATIC'}`,
    enabled: true,
    fields: fieldKeys.map((key) => FIELD_DEFINITIONS[key]),
    dateRule: { type: 'offset-months', months, format: 'DD/MM/YYYY' },
    timeRule: { type: 'production-time', format: 'HH:mm:ss' },
    previewLines: lines,
    printerAssignments: [{
      printerId,
      printerMessageName: `CAT ${code} ${monthLabel} ${hash.slice(0, 6).toUpperCase()}`,
      enabled: true
    }]
  };
}

function resolvePrinterIds(printers, overrides = {}) {
  const ids = {};
  for (const [role, name] of Object.entries(DEFAULT_PRINTER_NAMES)) {
    if (overrides[role]) {
      if (!printers.some((printer) => printer.id === overrides[role])) throw new Error(`Printer ${overrides[role]} was not found.`);
      ids[role] = overrides[role];
      continue;
    }
    const matches = printers.filter((printer) => printer.enabled && printer.name.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) throw new Error(`Expected exactly one enabled ${name}; found ${matches.length}.`);
    ids[role] = matches[0].id;
  }
  return ids;
}

function linesFromRow(row, prefix) {
  return [row[`${prefix}Line1`], row[`${prefix}Line2`], row[`${prefix}Line3`]]
    .map(normalizeTemplate)
    .filter(Boolean);
}

function buildProductCatalog(rows, printers, options = {}) {
  const printerIds = resolvePrinterIds(printers, options.printerIds);
  const messagesById = new Map();
  const masters = [];
  const skipped = [];
  const seenSkus = new Set();

  for (const row of rows) {
    const sku = normalizeWhitespace(row.sku).toUpperCase();
    const line = normalizeWhitespace(row.sourceWorkbook).toLowerCase();
    if (!sku || !/^[A-Z0-9][A-Z0-9._-]{1,29}$/.test(sku)) throw new Error(`Invalid or missing SKU ${row.sku || '(blank)'}.`);
    if (seenSkus.has(sku)) throw new Error(`Duplicate SKU ${sku}.`);
    seenSkus.add(sku);
    if (line !== 'cans' && line !== 'bottles') throw new Error(`Unsupported source workbook ${row.sourceWorkbook} for SKU ${sku}.`);

    const primaryLines = linesFromRow(row, 'primary');
    const caseLines = linesFromRow(row, 'secondary');
    if (!primaryLines.length || !caseLines.length) {
      skipped.push({ sku, productCode: normalizeWhitespace(row.productCode), product: normalizeWhitespace(row.product), reason: 'Missing primary or case coding instructions' });
      continue;
    }

    const months = parseMonths(row);
    const configurations = [];
    for (const definition of [
      { role: line, printerId: printerIds[line], lines: primaryLines },
      { role: 'case', printerId: printerIds.case, lines: caseLines }
    ]) {
      const message = buildMessage({ ...definition, months });
      messagesById.set(message.id, message);
      configurations.push({
        printerId: definition.printerId,
        messageId: message.id,
        fieldMappings: message.fields.map((field) => ({ fieldKey: field.key, source: FIELD_SOURCES[field.key] })),
        dateRule: message.dateRule,
        timeRule: message.timeRule,
        previewLines: message.previewLines
      });
    }

    masters.push({
      productCode: sku,
      packagingCategory: line,
      displayName: normalizeWhitespace(row.product) || `${normalizeWhitespace(row.productCode)} (${sku})`,
      enabled: true,
      nextRunNumber: 1,
      specification: {
        runPrefix: 'T',
        runWidth: 4,
        bestBeforeMonths: months,
        defaultBrewSheetProduct: normalizeWhitespace(row.batchCode || row.productCode),
        printerConfigurations: configurations
      },
      catalog: {
        sourceWorkbook: line,
        sourceSheetName: normalizeWhitespace(row.sourceSheetName),
        batchCode: normalizeWhitespace(row.batchCode),
        productCode: normalizeWhitespace(row.productCode),
        warnings: normalizeWhitespace(row.warnings)
      }
    });
  }

  const messages = [...messagesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const nameGroups = new Map();
  for (const message of messages) {
    const key = `${message.printerAssignments[0].printerId}:${message.displayName}`;
    if (!nameGroups.has(key)) nameGroups.set(key, []);
    nameGroups.get(key).push(message);
  }
  for (const group of nameGroups.values()) {
    if (group.length < 2) continue;
    group.forEach((message, index) => { message.displayName = `${message.displayName} ${String.fromCharCode(65 + index)}`; });
  }
  validateMessages(messages, { printers });
  return { messages, masters, skipped, printerIds };
}

async function readProductCatalog(csvPath) {
  const csv = await fs.readFile(csvPath, 'utf8');
  return parse(csv, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: false, trim: false });
}

function importProductCatalog(catalog, options = {}) {
  const db = options.db || getDb();
  const actor = options.actor || { username: 'catalog-import', developmentIdentity: true };
  const existingByCode = new Map(listProductMasters({}, db).map((master) => [master.productCode.toUpperCase(), master]));
  const result = { messagesUpserted: 0, mastersCreated: 0, mastersUpdated: 0, mastersUnchanged: 0, skipped: catalog.skipped };

  db.transaction(() => {
    for (const message of catalog.messages) {
      upsertMessage(resolveMessageUserFields(message, db), db);
      result.messagesUpserted += 1;
    }
    for (const input of catalog.masters) {
      const existing = existingByCode.get(input.productCode);
      if (!existing) {
        const created = createProductMaster(input, actor, db);
        existingByCode.set(input.productCode, created);
        result.mastersCreated += 1;
        continue;
      }
      const desiredSpecification = normalizeSpecification(input.specification);
      const unchanged = existing.displayName === input.displayName
        && existing.packagingCategory === input.packagingCategory
        && existing.enabled === input.enabled
        && JSON.stringify(existing.specification) === JSON.stringify(desiredSpecification);
      if (unchanged) {
        result.mastersUnchanged += 1;
        continue;
      }
      updateProductMaster(existing.id, {
        displayName: input.displayName,
        packagingCategory: input.packagingCategory,
        enabled: input.enabled,
        nextRunNumber: existing.nextRunNumber,
        specification: input.specification
      }, actor, db);
      result.mastersUpdated += 1;
    }
  })();

  return result;
}

export {
  buildProductCatalog,
  importProductCatalog,
  normalizeTemplate,
  readProductCatalog,
  resolvePrinterIds
};

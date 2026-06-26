import { getDb } from './db.js';
import { getMessageByIdFromDb } from './repositories/message-repository.js';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatReleaseDate(date, format = 'DD/MM/YYYY') {
  const values = {
    DD: pad2(date.getUTCDate()), MM: pad2(date.getUTCMonth() + 1),
    YYYY: String(date.getUTCFullYear()), YY: String(date.getUTCFullYear()).slice(-2)
  };
  return format.replace(/YYYY|YY|DD|MM/g, (token) => values[token]);
}

function formatReleaseTime(date, format = 'HH:mm:ss') {
  if (format === 'HH:mm') return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  if (format === 'hh:mm A') {
    const period = date.getUTCHours() >= 12 ? 'PM' : 'AM';
    return `${pad2(date.getUTCHours() % 12 || 12)}:${pad2(date.getUTCMinutes())} ${period}`;
  }
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function addMonthsClamped(date, months) {
  const result = new Date(date.valueOf());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function addDays(date, days) {
  const result = new Date(date.valueOf());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function bestBeforeDateForRule(production, rule = {}, fallbackMonths = 0) {
  if (rule.type === 'offset-days') return addDays(production, Number(rule.days ?? rule.months ?? 0));
  return addMonthsClamped(production, Number(rule.months ?? fallbackMonths ?? 0));
}

function renderTemplate(template, values) {
  return template.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key) => values[key] ?? '');
}

function printerConfigurations(specification) {
  return specification.printerConfigurations || [];
}

function defaultReleaseSource(field) {
  const value = `${field.key} ${field.label} ${field.printerFieldName}`.toLowerCase();
  if (value.includes('run')) return 'run_code';
  if (value.includes('brew')) return 'brew_number';
  return 'brew_sheet_product';
}

function currentMessageConfiguration(configuration, db) {
  const message = getMessageByIdFromDb(configuration.messageId, db);
  if (!message) return configuration;
  if (!message.enabled) throw new Error(`Stored message ${configuration.messageId} is unavailable.`);
  const assignment = message.printerAssignments.find((item) => item.printerId === configuration.printerId && item.enabled);
  if (!assignment) throw new Error(`${message.displayName} is no longer assigned to printer ${configuration.printerId}.`);
  const mappingByKey = new Map((configuration.fieldMappings || []).map((mapping) => [mapping.fieldKey, mapping.source]));
  return {
    ...configuration,
    fieldMappings: message.fields.map((field) => ({ fieldKey: field.key, source: mappingByKey.get(field.key) || defaultReleaseSource(field) })),
    dateRule: message.dateRule,
    timeRule: message.timeRule,
    previewLines: message.previewLines
  };
}

function expectedOutputForRelease(release, version, runNumber, db = getDb()) {
  const specification = JSON.parse(version.specification_json);
  const digits = String(runNumber).padStart(specification.runWidth, '0');
  if (digits.length > specification.runWidth) throw new Error('The product run sequence exceeds its configured width.');
  const runCode = `${specification.runPrefix}${digits}`;
  const production = new Date(release.plannedProductionAt);
  const sourceValues = {
    run_code: runCode,
    brew_sheet_product: release.brewSheetProduct,
    brew_number: release.brewNumber || '',
  };
  const byPrinter = {};
  const activePrinterIds = new Set(release.printerIds || []);
  const currentConfigurations = printerConfigurations(specification)
    .filter((configuration) => activePrinterIds.has(configuration.printerId))
    .map((configuration) => currentMessageConfiguration(configuration, db));
  for (const configuration of currentConfigurations) {
    const bestBefore = bestBeforeDateForRule(production, configuration.dateRule, specification.bestBeforeMonths);
    const values = {
      run: runCode,
      batch: release.brewSheetProduct,
      bestBeforeDate: formatReleaseDate(bestBefore, configuration.dateRule?.format),
      productionTime: formatReleaseTime(production, configuration.timeRule?.format)
    };
    values.currentTime = values.productionTime;
    const fieldMappings = configuration.fieldMappings || [];
    const fields = Object.fromEntries(fieldMappings.map((mapping) => [mapping.fieldKey, sourceValues[mapping.source] ?? '']));
    Object.assign(values, fields);
    const lines = (configuration.previewLines || []).map((line) => renderTemplate(line, values));
    byPrinter[configuration.printerId] = {
      printerId: configuration.printerId,
      messageId: configuration.messageId,
      plannedProductionAt: release.plannedProductionAt,
      runCode,
      configuration: {
        fieldMappings: configuration.fieldMappings,
        previewLines: configuration.previewLines,
        dateRule: configuration.dateRule,
        timeRule: configuration.timeRule
      },
      fields,
      lines,
      rendered: lines.join('\n')
    };
  }
  const firstOutput = byPrinter[release.printerIds[0]] || Object.values(byPrinter)[0];
  const liveSpecification = { ...specification, printerConfigurations: currentConfigurations };
  const expectedOutput = { ...firstOutput, byPrinter, specification: liveSpecification, productMasterVersionId: version.id };
  return { runCode, expectedOutput };
}

export {
  addDays,
  addMonthsClamped,
  bestBeforeDateForRule,
  currentMessageConfiguration,
  defaultReleaseSource,
  expectedOutputForRelease,
  formatReleaseDate,
  formatReleaseTime,
  pad2,
  renderTemplate
};

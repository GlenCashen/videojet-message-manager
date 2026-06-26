function pad2(value) {
  return String(value).padStart(2, '0');
}

function asDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  return Number.isNaN(date.valueOf()) ? new Date(fallback) : date;
}

function datePartsUtc(date) {
  return {
    DD: pad2(date.getUTCDate()),
    MM: pad2(date.getUTCMonth() + 1),
    YYYY: String(date.getUTCFullYear()),
    YY: String(date.getUTCFullYear()).slice(-2)
  };
}

function datePartsLocal(date) {
  return {
    DD: pad2(date.getDate()),
    MM: pad2(date.getMonth() + 1),
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2)
  };
}

function formatDate(parts, format = 'DD/MM/YYYY') {
  return format.replace(/YYYY|YY|DD|MM/g, (token) => parts[token]);
}

function formatTime(date, format = 'HH:mm:ss', { utc = true } = {}) {
  const hour = utc ? date.getUTCHours() : date.getHours();
  const minute = utc ? date.getUTCMinutes() : date.getMinutes();
  const second = utc ? date.getUTCSeconds() : date.getSeconds();
  if (format === 'HH:mm') return `${pad2(hour)}:${pad2(minute)}`;
  if (format === 'hh:mm A') return `${pad2(hour % 12 || 12)}:${pad2(minute)} ${hour >= 12 ? 'PM' : 'AM'}`;
  return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

function addMonthsClampedUtc(date, months) {
  const result = new Date(date.valueOf());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + Number(months || 0));
  result.setUTCDate(Math.min(day, new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()));
  return result;
}

function addMonthsClampedLocal(date, months) {
  const result = new Date(date.valueOf());
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + Number(months || 0));
  result.setDate(Math.min(day, new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()));
  return result;
}

function addDaysUtc(date, days) {
  const result = new Date(date.valueOf());
  result.setUTCDate(result.getUTCDate() + Number(days || 0));
  return result;
}

function addDaysLocal(date, days) {
  const result = new Date(date.valueOf());
  result.setDate(result.getDate() + Number(days || 0));
  return result;
}

function bestBeforeDateForRule(production, rule = {}, { utc = true } = {}) {
  if (rule?.type === 'offset-days') {
    return utc
      ? addDaysUtc(production, rule.days ?? rule.months ?? 0)
      : addDaysLocal(production, rule.days ?? rule.months ?? 0);
  }
  return utc
    ? addMonthsClampedUtc(production, rule?.months || 0)
    : addMonthsClampedLocal(production, rule?.months || 0);
}

function formatBestBeforeDate(date, rule = {}, { utc = true } = {}) {
  return formatDate(utc ? datePartsUtc(date) : datePartsLocal(date), rule?.format || 'DD/MM/YYYY');
}

function renderTemplateLine(line, values) {
  return String(line || '').replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key) => values[key] ?? `[${key}]`);
}

function renderConfiguredLines(configuration = {}, sourceValues = {}) {
  const values = {
    ...sourceValues,
    bestBeforeDate: sourceValues.bestBeforeDate || '',
    currentTime: sourceValues.currentTime || sourceValues.productionTime || '',
    productionTime: sourceValues.productionTime || sourceValues.currentTime || ''
  };
  if (sourceValues.fields) Object.assign(values, sourceValues.fields);
  for (const mapping of configuration.fieldMappings || []) {
    values[mapping.fieldKey] = sourceValues.fields?.[mapping.fieldKey] ?? sourceValues[mapping.source] ?? '';
  }
  return (configuration.previewLines || []).map((line) => renderTemplateLine(line, values));
}

function previewValues(configuration, release, options = {}) {
  const production = asDate(release.plannedProductionAt, options.now);
  const now = asDate(options.now, new Date());
  const timeSource = options.liveTime === false ? production : now;
  const bestBefore = bestBeforeDateForRule(production, configuration.dateRule, { utc: true });
  const productionTime = formatTime(timeSource, configuration.timeRule?.format || 'HH:mm:ss', { utc: true });
  return {
    run_code: release.runCode || '[assigned when sent]',
    brew_sheet_product: release.brewSheetProduct || '',
    brew_number: release.brewNumber || '',
    bestBeforeDate: formatBestBeforeDate(bestBefore, configuration.dateRule, { utc: true }),
    productionTime,
    currentTime: productionTime
  };
}

function messageExpectedOutput(message, fields = {}, options = {}) {
  const now = asDate(options.now, new Date());
  const production = asDate(options.productionDate, now);
  const bestBefore = bestBeforeDateForRule(production, message.dateRule, { utc: false });
  const currentTime = formatTime(production, message.timeRule?.format || 'HH:mm:ss', { utc: false });
  const values = {
    ...fields,
    bestBeforeDate: formatBestBeforeDate(bestBefore, message.dateRule, { utc: false }),
    currentTime,
    productionTime: currentTime
  };
  const lines = (message.previewLines || []).map((line) => renderTemplateLine(line, values));
  return {
    messageId: message.id,
    displayName: message.displayName,
    printerMessageName: message.printerMessageName,
    fields,
    bestBeforeDate: values.bestBeforeDate,
    currentTime,
    lines,
    rendered: lines.join('\n')
  };
}

function configurationFor(release, printerId) {
  return (release.productMasterSpecification?.printerConfigurations || release.expectedOutput?.specification?.printerConfigurations || [])
    .find((item) => item.printerId === printerId);
}

function releaseExpectedOutput(release, printerId, options = {}) {
  const recorded = release.expectedOutput?.byPrinter?.[printerId] || (!release.expectedOutput?.byPrinter ? release.expectedOutput : null);
  const configuration = configurationFor(release, printerId) || recorded?.configuration;
  if (!configuration) {
    if (recorded?.rendered) return { rendered: recorded.rendered, provisional: false };
    return { rendered: 'Expected print is not configured for this printer.', provisional: true };
  }
  const sourceValues = previewValues(configuration, {
    ...release,
    plannedProductionAt: release.plannedProductionAt || recorded?.plannedProductionAt,
    runCode: release.runCode || recorded?.runCode
  }, options);
  const lines = renderConfiguredLines(configuration, { ...sourceValues, fields: recorded?.fields || {} });
  return {
    rendered: lines.join('\n') || recorded?.rendered || 'No expected print lines are configured.',
    provisional: !recorded?.rendered
  };
}

function expectedOutputText(expectedOutput, printerId = null, options = {}) {
  if (!expectedOutput?.rendered) return 'No expected output recorded';
  const output = printerId && expectedOutput.byPrinter ? expectedOutput.byPrinter[printerId] : expectedOutput;
  const configuration = output?.configuration || (printerId
    ? (expectedOutput.specification?.printerConfigurations || []).find((item) => item.printerId === printerId)
    : null);
  if (!configuration || !output?.plannedProductionAt) return output?.rendered || expectedOutput.rendered;
  const sourceValues = previewValues(configuration, {
    plannedProductionAt: output.plannedProductionAt,
    runCode: output.runCode || expectedOutput.runCode
  }, options);
  const rendered = renderConfiguredLines(configuration, { ...sourceValues, fields: output.fields || {} }).join('\n');
  return rendered || output.rendered || expectedOutput.rendered;
}

export {
  expectedOutputText,
  messageExpectedOutput,
  previewValues,
  releaseExpectedOutput,
  renderConfiguredLines
};

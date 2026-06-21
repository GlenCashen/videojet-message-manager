function pad2(value) {
  return String(value).padStart(2, '0');
}

function previewValues(configuration, release) {
  const production = new Date(release.plannedProductionAt);
  const bestBefore = new Date(production.valueOf());
  const day = bestBefore.getUTCDate();
  bestBefore.setUTCDate(1);
  bestBefore.setUTCMonth(bestBefore.getUTCMonth() + Number(configuration.dateRule?.months || 0));
  bestBefore.setUTCDate(Math.min(day, new Date(Date.UTC(bestBefore.getUTCFullYear(), bestBefore.getUTCMonth() + 1, 0)).getUTCDate()));
  const dateParts = { DD: pad2(bestBefore.getUTCDate()), MM: pad2(bestBefore.getUTCMonth() + 1), YYYY: String(bestBefore.getUTCFullYear()), YY: String(bestBefore.getUTCFullYear()).slice(-2) };
  const bestBeforeDate = (configuration.dateRule?.format || 'DD/MM/YYYY').replace(/YYYY|YY|DD|MM/g, (token) => dateParts[token]);
  const hour = production.getUTCHours();
  const format = configuration.timeRule?.format || 'HH:mm:ss';
  const productionTime = format === 'HH:mm'
    ? `${pad2(hour)}:${pad2(production.getUTCMinutes())}`
    : format === 'hh:mm A'
      ? `${pad2(hour % 12 || 12)}:${pad2(production.getUTCMinutes())} ${hour >= 12 ? 'PM' : 'AM'}`
      : `${pad2(hour)}:${pad2(production.getUTCMinutes())}:${pad2(production.getUTCSeconds())}`;
  return { run_code: release.runCode || '[assigned when sent]', brew_sheet_product: release.brewSheetProduct || '', brew_number: release.brewNumber || '', bestBeforeDate, productionTime };
}

function releaseExpectedOutput(release, printerId) {
  const recorded = release.expectedOutput?.byPrinter?.[printerId] || (!release.expectedOutput?.byPrinter ? release.expectedOutput : null);
  if (recorded?.rendered) return { rendered: recorded.rendered, provisional: false };
  const configuration = (release.productMasterSpecification?.printerConfigurations || []).find((item) => item.printerId === printerId);
  if (!configuration) return { rendered: 'Expected print is not configured for this printer.', provisional: true };
  const sourceValues = previewValues(configuration, release);
  const values = { bestBeforeDate: sourceValues.bestBeforeDate, currentTime: sourceValues.productionTime, productionTime: sourceValues.productionTime };
  for (const mapping of configuration.fieldMappings || []) values[mapping.fieldKey] = sourceValues[mapping.source] || '';
  const lines = (configuration.previewLines || []).map((line) => line.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key) => values[key] ?? `[${key}]`));
  return { rendered: lines.join('\n') || 'No expected print lines are configured.', provisional: true };
}

export { releaseExpectedOutput };

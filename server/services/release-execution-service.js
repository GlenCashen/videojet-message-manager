function httpError(message, statusCode = 409, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function createReleaseExecutionService({
  canOperatePrinter,
  readPrinters,
  loadMessages,
  getMessageForPrinter,
  renderPreview,
  sameDateRule,
  verifyBatchReleaseTarget,
  endBatchReleaseTargetRun
}) {
  async function executionContext(release, printerId, user) {
    if (!canOperatePrinter(user, printerId)) {
      throw httpError('You do not have permission to operate this printer.', 403);
    }
    const target = release.executionTargets?.find((item) => item.printerId === printerId);
    if (!target) throw httpError('This printer is not assigned to the release.', 404);

    const printers = await readPrinters();
    const printer = printers.find((item) => item.id === printerId);
    if (!printer) throw new Error(`Printer ${printerId} was not found.`);
    if (!printer.enabled) throw httpError(`${printer.name} is disabled.`);

    const specification = release.productMasterSpecification;
    const configuration = specification?.printerConfigurations?.find((item) => item.printerId === printerId) || null;
    if (!configuration?.messageId) throw new Error('The approved release has no executable message specification for this printer.');

    const messages = await loadMessages(undefined, { printers });
    const message = getMessageForPrinter(messages, configuration.messageId, printerId);
    const approvedLines = configuration.previewLines;
    const mappedKeys = new Set((configuration.fieldMappings || []).map((mapping) => mapping.fieldKey));
    const definitionMatches = JSON.stringify(message.previewLines) === JSON.stringify(approvedLines)
      && sameDateRule(message.dateRule, configuration.dateRule)
      && (message.timeRule?.format || 'HH:mm:ss') === (configuration.timeRule?.format || 'HH:mm:ss')
      && [...mappedKeys].every((fieldKey) => message.fields.some((field) => field.key === fieldKey));
    if (!definitionMatches) {
      throw httpError('The stored message definition no longer matches the approved release. Return it for a new review.', 409, 'RELEASE_DEFINITION_CHANGED');
    }

    const expectedOutput = release.expectedOutput?.byPrinter?.[printerId] || release.expectedOutput || null;
    if (expectedOutput) {
      const preview = renderPreview(message, expectedOutput.fields || {}, { productionDate: release.plannedProductionAt });
      if (preview.rendered !== expectedOutput.rendered) {
        throw httpError('The approved release output no longer matches the stored message. Return it for a new review.', 409, 'RELEASE_DEFINITION_CHANGED');
      }
    }

    return { printer, target, message, expectedOutput };
  }

  function verifyPrintCheck({ releaseId, printerId, passed, reason, user }) {
    if (!canOperatePrinter(user, printerId)) {
      throw httpError('You do not have permission to operate this printer.', 403);
    }
    const release = verifyBatchReleaseTarget(releaseId, printerId, { passed, reason }, user);
    if (!release) return null;
    const target = release.executionTargets.find((item) => item.printerId === printerId);
    return {
      release,
      target,
      passed,
      reverify: target?.result?.reverify === true
    };
  }

  function endRun({ releaseId, printerId, user }) {
    if (!canOperatePrinter(user, printerId)) {
      throw httpError('You do not have permission to operate this printer.', 403);
    }
    return endBatchReleaseTargetRun(releaseId, printerId, user);
  }

  return {
    endRun,
    executionContext,
    verifyPrintCheck
  };
}

export { createReleaseExecutionService };

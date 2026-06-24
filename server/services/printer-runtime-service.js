function createPrinterRuntimeService({
  insertMessageUpdateEvent,
  persistExpectedOutput,
  releaseAudit,
  releaseExecutionService,
  setPrinterMessage
}) {
  async function applyReleaseLocally({ release, printer, execution, user, reverify = false }) {
    const result = {
      ...await setPrinterMessage(printer, {
        messageId: execution.expectedOutput.messageId,
        fields: execution.expectedOutput.fields || {},
        productionDate: release.plannedProductionAt
      }),
      reverify
    };

    insertMessageUpdateEvent(result, user);
    if (result.ok && result.expectedOutput) await persistExpectedOutput(printer.id, result.expectedOutput);

    const { release: updated, endedReleaseIds } = releaseExecutionService.finishApply({
      releaseId: release.id,
      printerId: printer.id,
      result
    });

    for (const endedReleaseId of endedReleaseIds) {
      releaseAudit.runEndedBySwitch(user, endedReleaseId, printer, release);
    }
    releaseAudit.applicationFinished(user, updated, printer, result, { reverify });

    return { result, release: updated, endedReleaseIds };
  }

  return { applyReleaseLocally };
}

export { createPrinterRuntimeService };

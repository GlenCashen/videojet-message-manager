function createPrinterRuntimeService({
  insertMessageUpdateEvent,
  persistExpectedOutput,
  releaseAudit,
  releaseExecutionService,
  setPrinterMessage
}) {
  function agentActor(agent) {
    return { username: `agent:${agent.id}`, developmentIdentity: true };
  }

  async function completeAgentReleaseApply({ agent, job, result }) {
    insertMessageUpdateEvent(result, agentActor(agent));
    if (result.ok && result.expectedOutput) await persistExpectedOutput(job.printerId, result.expectedOutput);

    const { release: updated, endedReleaseIds } = releaseExecutionService.finishApply({
      releaseId: job.releaseId,
      printerId: job.printerId,
      result
    });
    releaseAudit.agentApplicationFinished(agent, updated, job.printerId, result, job);

    return { release: updated, endedReleaseIds };
  }

  function markApplyFailed({ releaseId, printerId, failure, user }) {
    const updated = releaseExecutionService.markApplyFailed({ releaseId, printerId, failure });
    insertMessageUpdateEvent(failure, user || {});
    releaseAudit.applicationFailed(user, releaseId, printerId, failure, updated.status);
    return { release: updated };
  }

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

  return { applyReleaseLocally, completeAgentReleaseApply, markApplyFailed };
}

export { createPrinterRuntimeService };

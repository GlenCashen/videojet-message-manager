function createPrinterRuntimeService({
  addLog,
  auditActor,
  insertMessageUpdateEvent,
  persistExpectedOutput,
  releaseAudit,
  releaseExecutionService,
  setPrinterMessage
}) {
  function agentActor(agent) {
    return { username: `agent:${agent.id}`, developmentIdentity: true };
  }

  function manualAgentActor(agent, job) {
    return {
      id: job.context.actorUserId || null,
      username: job.context.actorUsername || `agent:${agent.id}`,
      developmentIdentity: !job.context.actorUserId
    };
  }

  async function recordAgentResult({ actor, printerId, result }) {
    insertMessageUpdateEvent(result, actor);
    if (result.ok && result.expectedOutput) await persistExpectedOutput(printerId, result.expectedOutput);
  }

  async function completeAgentManualJob({ agent, job, result }) {
    const actor = manualAgentActor(agent, job);
    await recordAgentResult({ actor, printerId: job.printerId, result });
    addLog({
      action: result.ok && result.messageMatches !== false ? 'message-update-success' : 'message-update-failure',
      ...auditActor(actor),
      targetType: 'printer',
      targetId: job.printerId,
      printerId: job.printerId,
      operationId: result.operationId,
      requestedMessage: result.requestedMessage || result.expectedOutput?.printerMessageName,
      selectedMessage: result.selectedMessage,
      rawStatus: result.rawStatus,
      decodedFaultCodes: result.decodedStatus?.faults?.map((fault) => fault.code) || [],
      fieldResults: result.fieldResults,
      error: result.technicalMessage || result.error || null,
      details: {
        reason: job.context.reason,
        mode: 'manual-exception',
        agentId: agent.id,
        jobId: job.id,
        operatorMessage: result.operatorMessage || null,
        technicalMessage: result.technicalMessage || result.error || null
      }
    });
    return { job, result };
  }

  async function completeAgentReleaseApply({ agent, job, result }) {
    await recordAgentResult({ actor: agentActor(agent), printerId: job.printerId, result });

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

  return { applyReleaseLocally, completeAgentManualJob, completeAgentReleaseApply, markApplyFailed };
}

export { createPrinterRuntimeService };

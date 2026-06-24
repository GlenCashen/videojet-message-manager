function baseReleaseDetails(release = {}, extras = {}) {
  return {
    releaseId: release.id,
    productMasterId: release.productMasterId || null,
    brewSheetProduct: release.brewSheetProduct || null,
    brewNumber: release.brewNumber || null,
    runNumber: release.runNumber || null,
    runCode: release.runCode || null,
    releaseStatus: release.status || null,
    ...extras
  };
}

function createReleaseAuditService({ addLog, auditActor }) {
  function record(action, actor, release, { printerId = null, details = {}, error = null } = {}) {
    addLog({
      action,
      ...(actor ? auditActor(actor) : { actor: 'System' }),
      targetType: 'batch-release',
      targetId: release?.id || details.releaseId || null,
      printerId,
      ...(error ? { error } : {}),
      details: baseReleaseDetails(release, {
        printerId,
        ...details
      })
    });
  }

  function runAssigned(actor, release, printer) {
    record('batch-release-run-assigned', actor, release, {
      printerId: printer.id,
      details: {
        runNumber: release.runNumber,
        runCode: release.runCode,
        ok: true
      }
    });
  }

  function applicationStarted(actor, release, printer, { reapply = false, reverify = false, reason = null } = {}) {
    record(reverify ? 'batch-release-reverify-started' : 'batch-release-application-started', actor, release, {
      printerId: printer.id,
      details: {
        reapply,
        reverify,
        reason: reason || null,
        ok: true
      }
    });
  }

  function agentJobQueued(actor, release, printer, job) {
    record('batch-release-agent-job-queued', actor, release, {
      printerId: printer.id,
      details: {
        jobId: job.id,
        payloadHash: job.payloadHash,
        ok: true
      }
    });
  }

  function runEndedBySwitch(actor, endedReleaseId, printer, replacementRelease) {
    addLog({
      action: 'batch-release-run-ended-by-switch',
      ...auditActor(actor),
      targetType: 'batch-release',
      targetId: endedReleaseId,
      printerId: printer.id,
      details: {
        releaseId: endedReleaseId,
        printerId: printer.id,
        replacedByReleaseId: replacementRelease.id,
        replacedByRunCode: replacementRelease.runCode || null,
        replacementReleaseStatus: replacementRelease.status || null,
        ok: true
      }
    });
  }

  function applicationFinished(actor, release, printer, result, { reverify = false } = {}) {
    const succeeded = result?.ok && result?.messageMatches !== false;
    record(succeeded ? (reverify ? 'batch-release-reverify-sent' : 'batch-release-application-sent') : 'batch-release-printer-state-uncertain', actor, release, {
      printerId: printer.id,
      details: {
        operationId: result?.operationId || null,
        selectedMessage: result?.selectedMessage || null,
        requestedMessage: result?.requestedMessage || result?.expectedMessage || null,
        messageMatches: result?.messageMatches,
        verificationAvailable: result?.verificationAvailable,
        rawStatus: result?.rawStatus || null,
        reverify,
        ok: succeeded
      }
    });
  }

  function applicationFailed(actor, releaseId, printerId, failure, status = null) {
    addLog({
      action: 'batch-release-printer-state-uncertain',
      ...(actor ? auditActor(actor) : { actor: 'System' }),
      targetType: 'batch-release',
      targetId: releaseId,
      printerId,
      error: failure.technicalMessage || failure.error,
      details: {
        releaseId,
        printerId,
        error: failure.technicalMessage || failure.error,
        operatorMessage: failure.operatorMessage || null,
        technicalMessage: failure.technicalMessage || failure.error,
        status,
        ok: false
      }
    });
  }

  function printChecked(actor, release, printerId, { passed, reason = '', reverify = false } = {}) {
    record(passed ? (reverify ? 'batch-release-reverified' : 'batch-release-print-verified') : 'batch-release-print-failed', actor, release, {
      printerId,
      details: {
        reason: passed ? null : String(reason || '').trim(),
        reverify,
        ok: passed
      }
    });
  }

  function productionRunning(actor, release, printerId, { reverify = false } = {}) {
    record('batch-release-running', actor, release, {
      printerId,
      details: {
        status: 'running',
        reverify,
        ok: true
      }
    });
  }

  function runEnded(actor, release, printerId) {
    record('batch-release-run-ended', actor, release, {
      printerId,
      details: {
        ok: true
      }
    });
  }

  return {
    agentJobQueued,
    applicationFailed,
    applicationFinished,
    applicationStarted,
    printChecked,
    productionRunning,
    runAssigned,
    runEnded,
    runEndedBySwitch
  };
}

export { createReleaseAuditService };

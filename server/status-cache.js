import { decodeStatus } from './wsi-status.js';

function nowIso() {
  return new Date().toISOString();
}

function initialStatus(printerId) {
  return {
    printerId,
    online: false,
    stale: true,
    busy: false,
    currentOperation: null,
    currentOperationId: null,
    revision: 0,
    selectedMessage: null,
    rawStatus: null,
    decodedStatus: null,
    expectedOutput: null,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    responseTimeMs: null,
    consecutiveFailures: 0,
    lastError: null
  };
}

function publicStatus(status) {
  return {
    ...status,
    decodedStatus: status.decodedStatus ? { ...status.decodedStatus } : null,
    expectedOutput: status.expectedOutput ? JSON.parse(JSON.stringify(status.expectedOutput)) : null
  };
}

function materialFields(status) {
  return {
    online: status.online,
    stale: status.stale,
    busy: status.busy,
    currentOperation: status.currentOperation,
    currentOperationId: status.currentOperationId,
    selectedMessage: status.selectedMessage,
    rawStatus: status.rawStatus,
    expectedOutput: status.expectedOutput,
    lastError: status.lastError,
    consecutiveFailures: status.consecutiveFailures
  };
}

function isMaterialChange(before, after) {
  return JSON.stringify(materialFields(before)) !== JSON.stringify(materialFields(after));
}

class StatusCache {
  constructor({ staleAfterMs = 15000, offlineAfterFailures = 3, onChange = () => {}, onTransition = () => {} } = {}) {
    this.staleAfterMs = staleAfterMs;
    this.offlineAfterFailures = offlineAfterFailures;
    this.onChange = onChange;
    this.onTransition = onTransition;
    this.records = new Map();
  }

  ensure(printerId) {
    if (!this.records.has(printerId)) this.records.set(printerId, initialStatus(printerId));
    return this.records.get(printerId);
  }

  syncPrinters(printers) {
    const ids = new Set(printers.map((printer) => printer.id));
    for (const printer of printers) this.ensure(printer.id);
    for (const id of this.records.keys()) {
      if (!ids.has(id)) this.records.delete(id);
    }
  }

  get(printerId) {
    return publicStatus(this.refreshStale(printerId));
  }

  all() {
    return [...this.records.keys()].map((id) => this.get(id));
  }

  refreshStale(printerId) {
    const current = this.ensure(printerId);
    const before = { ...current };
    const lastSuccess = current.lastSuccessfulAt ? new Date(current.lastSuccessfulAt).valueOf() : 0;
    current.stale = !lastSuccess || Date.now() - lastSuccess > this.staleAfterMs;
    this.commit(printerId, before, current, { broadcast: false });
    return current;
  }

  startOperation(printerId, operation, operationId) {
    const current = this.ensure(printerId);
    const before = { ...current };
    current.busy = true;
    current.currentOperation = operation;
    current.currentOperationId = operationId;
    current.lastAttemptAt = nowIso();
    this.commit(printerId, before, current, { force: true, event: 'operation-started' });
    return this.get(printerId);
  }

  completeOperation(printerId) {
    const current = this.ensure(printerId);
    const before = { ...current };
    current.busy = false;
    current.currentOperation = null;
    current.currentOperationId = null;
    this.commit(printerId, before, current, { force: true, event: 'operation-completed' });
    return this.get(printerId);
  }

  restoreExpectedOutput(printerId, expectedOutput) {
    const current = this.ensure(printerId);
    const before = { ...current };
    current.expectedOutput = expectedOutput ? JSON.parse(JSON.stringify(expectedOutput)) : null;
    this.commit(printerId, before, current, { broadcast: false });
    return this.get(printerId);
  }

  applySuccess(printerId, { selectedMessage, rawStatus, responseTimeMs, expectedOutput }) {
    const current = this.ensure(printerId);
    const before = { ...current };
    const decodedStatus = decodeStatus(rawStatus);
    const timestamp = nowIso();

    current.online = true;
    current.stale = false;
    current.selectedMessage = selectedMessage;
    current.rawStatus = decodedStatus.valid ? decodedStatus.raw : rawStatus;
    current.decodedStatus = decodedStatus;
    if (expectedOutput) current.expectedOutput = JSON.parse(JSON.stringify(expectedOutput));
    current.lastAttemptAt = timestamp;
    current.lastSuccessfulAt = timestamp;
    current.responseTimeMs = responseTimeMs;
    current.consecutiveFailures = 0;
    current.lastError = decodedStatus.valid ? null : decodedStatus.error;

    this.commit(printerId, before, current);
    return this.get(printerId);
  }

  applyFailure(printerId, error) {
    const current = this.ensure(printerId);
    const before = { ...current };
    current.lastAttemptAt = nowIso();
    current.consecutiveFailures += 1;
    current.lastError = error.message || String(error);
    if (current.consecutiveFailures >= this.offlineAfterFailures) current.online = false;
    const lastSuccess = current.lastSuccessfulAt ? new Date(current.lastSuccessfulAt).valueOf() : 0;
    current.stale = !lastSuccess || Date.now() - lastSuccess > this.staleAfterMs;
    this.commit(printerId, before, current);
    return this.get(printerId);
  }

  markAttempt(printerId) {
    const current = this.ensure(printerId);
    const before = { ...current };
    current.lastAttemptAt = nowIso();
    this.commit(printerId, before, current);
  }

  hasRevision(printerId, expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return true;
    return Number(expectedRevision) === this.ensure(printerId).revision;
  }

  commit(printerId, before, current, { force = false, event = 'printer-status', broadcast = true } = {}) {
    const changed = force || isMaterialChange(before, current);
    if (changed) current.revision += 1;
    if (!before.online && current.online && before.consecutiveFailures >= this.offlineAfterFailures) {
      this.onTransition('offline -> online', publicStatus(current));
    }
    if (broadcast && changed) this.onChange(event, this.get(printerId));
  }
}

export { StatusCache, initialStatus };

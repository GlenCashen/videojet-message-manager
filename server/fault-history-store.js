import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_FAULT_HISTORY_PATH = path.join(__dirname, '..', 'data', 'fault-history.json');
const DEFAULT_HISTORY_LIMIT = 1000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function eventId(printerId, faultCode, event, occurredAt) {
  return `fault-${printerId}-${faultCode}-${event}-${occurredAt.replace(/[^0-9A-Z]/gi, '')}`;
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { active: {}, history: [] };
  }
  return {
    active: value.active && typeof value.active === 'object' && !Array.isArray(value.active) ? value.active : {},
    history: Array.isArray(value.history) ? value.history : []
  };
}

function activeRecordFromFault(printerId, fault, occurredAt, rawStatus) {
  return {
    printerId,
    faultCode: fault.code,
    faultLabel: fault.label,
    byte: fault.byte,
    bit: fault.bit,
    severity: fault.severity || 'fault',
    activatedAt: occurredAt,
    rawStatus
  };
}

class FaultHistoryStore {
  constructor({ filePath = DEFAULT_FAULT_HISTORY_PATH, limit = DEFAULT_HISTORY_LIMIT, now = nowIso } = {}) {
    this.filePath = filePath;
    this.limit = limit;
    this.now = now;
    this.active = {};
    this.history = [];
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = normalizeStore(JSON.parse(raw));
      this.active = data.active;
      this.history = data.history;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.active = {};
      this.history = [];
    }
    return this;
  }

  async save() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.fault-history-${process.pid}-${Date.now()}.tmp`);
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(`${JSON.stringify({ active: this.active, history: this.history }, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, this.filePath);
  }

  trimHistory() {
    if (this.history.length > this.limit) {
      this.history = this.history.slice(this.history.length - this.limit);
    }
  }

  activeFor(printerId) {
    return Object.values(this.active[printerId] || {}).map(clone);
  }

  async recordStatus(status) {
    const decoded = status?.decodedStatus;
    if (!status?.printerId || !decoded?.valid) return [];

    const printerId = status.printerId;
    const rawStatus = decoded.raw || status.rawStatus;
    const occurredAt = this.now();
    const currentFaults = decoded.activeFaults || decoded.faults || [];
    const currentByCode = new Map(currentFaults.map((fault) => [fault.code, fault]));
    const previous = this.active[printerId] || {};
    const nextActive = {};
    const events = [];

    for (const fault of currentFaults) {
      if (previous[fault.code]) {
        nextActive[fault.code] = previous[fault.code];
        continue;
      }

      const record = activeRecordFromFault(printerId, fault, occurredAt, rawStatus);
      nextActive[fault.code] = record;
      events.push({
        id: eventId(printerId, fault.code, 'activated', occurredAt),
        printerId,
        faultCode: fault.code,
        faultLabel: fault.label,
        byte: fault.byte,
        bit: fault.bit,
        severity: fault.severity || 'fault',
        event: 'activated',
        occurredAt,
        rawStatus
      });
    }

    for (const [faultCode, record] of Object.entries(previous)) {
      if (currentByCode.has(faultCode)) continue;
      const activatedAt = new Date(record.activatedAt).valueOf();
      const clearedAt = new Date(occurredAt).valueOf();
      events.push({
        id: eventId(printerId, faultCode, 'cleared', occurredAt),
        printerId,
        faultCode,
        faultLabel: record.faultLabel,
        byte: record.byte,
        bit: record.bit,
        severity: record.severity || 'fault',
        event: 'cleared',
        occurredAt,
        rawStatus,
        durationMs: Number.isFinite(activatedAt) && Number.isFinite(clearedAt)
          ? Math.max(0, clearedAt - activatedAt)
          : null
      });
    }

    this.active[printerId] = nextActive;
    if (events.length) {
      this.history.push(...events);
      this.trimHistory();
      await this.save();
    }
    return events.map(clone);
  }

  query({ printerId, activeOnly = false, from = null, to = null, limit = 100 } = {}) {
    const fromMs = from ? new Date(from).valueOf() : null;
    const toMs = to ? new Date(to).valueOf() : null;
    const matches = (event) => {
      if (printerId && event.printerId !== printerId) return false;
      const occurred = new Date(event.occurredAt || event.activatedAt).valueOf();
      if (fromMs !== null && occurred < fromMs) return false;
      if (toMs !== null && occurred > toMs) return false;
      return true;
    };

    const activeFaults = printerId
      ? this.activeFor(printerId)
      : Object.values(this.active).flatMap((records) => Object.values(records).map(clone));
    const history = activeOnly
      ? []
      : this.history.filter(matches).slice(-limit).reverse().map(clone);

    return {
      ...(printerId ? { printerId } : {}),
      activeFaults: activeFaults.filter(matches),
      history
    };
  }
}

async function createFaultHistoryStore(options = {}) {
  const store = new FaultHistoryStore(options);
  await store.load();
  return store;
}

export {
  DEFAULT_FAULT_HISTORY_PATH,
  DEFAULT_HISTORY_LIMIT,
  FaultHistoryStore,
  createFaultHistoryStore
};

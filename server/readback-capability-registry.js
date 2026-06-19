import { printerCapabilities } from './printer-capabilities.js';

class ReadbackCapabilityRegistry {
  constructor({ retryAfterMs = 300000, now = () => Date.now() } = {}) {
    this.retryAfterMs = retryAfterMs;
    this.now = now;
    this.records = new Map();
  }

  resolve(printer) {
    const configured = printerCapabilities(printer.model, printer.readbackMode);
    if (configured.currentMessageReadback !== null) return configured;
    const detected = this.records.get(printer.id);
    return {
      ...configured,
      currentMessageReadback: detected?.supported ?? null,
      currentMessageReadbackDetection: detected
        ? detected.supported ? 'supported' : 'unavailable'
        : 'unknown',
      currentMessageReadbackCheckedAt: detected?.checkedAt || null,
      currentMessageReadbackError: detected?.error || null
    };
  }

  shouldProbe(printer, { force = false } = {}) {
    const capabilities = this.resolve(printer);
    if (capabilities.currentMessageReadbackMode !== 'auto') return false;
    if (printer.model !== '1710') return false;
    if (force || capabilities.currentMessageReadback === true) return true;
    const record = this.records.get(printer.id);
    return !record || this.now() - record.checkedAtMs >= this.retryAfterMs;
  }

  record(printerId, supported, error = null) {
    const checkedAtMs = this.now();
    this.records.set(printerId, {
      supported: Boolean(supported),
      checkedAtMs,
      checkedAt: new Date(checkedAtMs).toISOString(),
      error: error ? error.message || String(error) : null
    });
  }

  clear(printerId) {
    this.records.delete(printerId);
  }
}

export { ReadbackCapabilityRegistry };

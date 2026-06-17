class Monitor {
  constructor({ readPrinters, pollPrinter, pollIntervalMs, betweenCoderDelayMs, delay, onError = () => {} }) {
    this.readPrinters = readPrinters;
    this.pollPrinter = pollPrinter;
    this.pollIntervalMs = pollIntervalMs;
    this.betweenCoderDelayMs = betweenCoderDelayMs;
    this.delay = delay;
    this.onError = onError;
    this.timer = null;
    this.running = false;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
  }

  schedule(ms = this.pollIntervalMs) {
    this.timer = setTimeout(() => this.loop(), ms);
  }

  async loop() {
    if (this.running) {
      this.schedule();
      return;
    }
    this.running = true;
    try {
      const printers = (await this.readPrinters()).filter((printer) => printer.enabled);
      for (const printer of printers) {
        await this.pollPrinter(printer);
        if (this.betweenCoderDelayMs > 0) await this.delay(this.betweenCoderDelayMs);
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      if (this.started) this.schedule();
    }
  }
}

export { Monitor };

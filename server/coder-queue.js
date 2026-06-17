class CoderQueue {
  constructor() {
    this.tails = new Map();
    this.active = new Map();
  }

  isBusy(printerId) {
    return Boolean(this.active.get(printerId));
  }

  getActive(printerId) {
    return this.active.get(printerId) || null;
  }

  async run(printerId, operation, task) {
    const previous = this.tails.get(printerId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => current);
    this.tails.set(printerId, queued);

    await previous.catch(() => {});
    this.active.set(printerId, operation);
    try {
      return await task();
    } finally {
      this.active.delete(printerId);
      release();
      if (this.tails.get(printerId) === queued) this.tails.delete(printerId);
    }
  }
}

export { CoderQueue };

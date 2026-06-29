import net from 'node:net';

class NgpclClient {
  constructor({ timeoutMs, onCommand, trace } = {}) {
    this.timeoutMs = timeoutMs || 5000;
    this.onCommand = onCommand || (() => {});
    this.trace = trace ?? ['1', 'true', 'yes'].includes(String(process.env.NGPCL_TRACE || '').toLowerCase());
    this.counters = new Map();
  }

  counterFor(printerId) {
    if (!this.counters.has(printerId)) {
      this.counters.set(printerId, { JR: 0, JS: 0, FR: 0, JU: 0, DR: 0, total: 0 });
    }
    return this.counters.get(printerId);
  }

  commandType(command) {
    return String(command || '').match(/^\{~([A-Z]{2})/)?.[1] || 'total';
  }

  getCounters() {
    return Object.fromEntries([...this.counters.entries()].map(([id, value]) => [id, { ...value }]));
  }

  resetCounters() {
    this.counters.clear();
  }

  traceEvent(event) {
    if (!this.trace) return;
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      protocol: 'ngpcl',
      ...event
    }));
  }

  sendCommand({ printerId, ip, port = 21000, command, timeoutMs = this.timeoutMs }) {
    const type = this.commandType(command);
    const counters = this.counterFor(printerId || `${ip}:${port}`);
    if (type in counters) counters[type] += 1;
    counters.total += 1;
    this.onCommand({ printerId, ip, port, command });
    this.traceEvent({ direction: 'tx', printerId, ip, port, type, command });

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let data = '';
      let settled = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) {
          this.traceEvent({
            direction: 'error',
            printerId,
            ip,
            port,
            type,
            code: error.code || null,
            message: error.message
          });
          reject(error);
        } else {
          this.traceEvent({
            direction: 'rx',
            printerId,
            ip,
            port,
            type,
            kind: value.kind,
            ascii: value.ascii,
            hex: value.hex
          });
          resolve(value);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.on('connect', () => socket.write(command, 'ascii'));
      socket.on('data', (chunk) => {
        data += chunk.toString('ascii');
        if (data.includes('}')) {
          finish(null, {
            kind: 'packet',
            value: data,
            ascii: data,
            hex: [...Buffer.from(data, 'ascii')].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
          });
        }
      });
      socket.on('timeout', () => {
        const error = new Error(`Printer did not respond to ${type} at ${ip}:${port} within ${timeoutMs} ms.`);
        error.code = 'NGPCL_TIMEOUT';
        finish(error);
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => {
        if (!settled) {
          if (data) {
            finish(null, {
              kind: 'raw',
              value: data,
              ascii: data,
              hex: [...Buffer.from(data, 'ascii')].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
            });
          } else {
            const error = new Error(`Printer closed the connection to ${ip}:${port} without replying to ${type}.`);
            error.code = 'NGPCL_PROTOCOL_ERROR';
            finish(error);
          }
        }
      });
      socket.connect(port, ip);
    });
  }
}

export { NgpclClient };

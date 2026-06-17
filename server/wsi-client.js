import net from 'node:net';

function buildPacket(command) {
  const payload = Buffer.from(command, 'ascii');
  return Buffer.concat([Buffer.from([0x02]), payload, Buffer.from([0x03])]);
}

function decodeResponse(buffer) {
  const hex = [...buffer].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const ascii = buffer.toString('ascii');

  if (buffer.length >= 2 && buffer[0] === 0x02 && buffer.at(-1) === 0x03) {
    return { kind: 'packet', value: buffer.subarray(1, -1).toString('ascii'), ascii, hex };
  }

  if (/^[!$][0-9A-F]{2}$/i.test(ascii)) {
    return { kind: ascii.startsWith('$') ? 'ack' : 'nack', value: ascii, ascii, hex };
  }

  return { kind: 'raw', value: ascii, ascii, hex };
}

class WsiClient {
  constructor({ timeoutMs, onCommand } = {}) {
    this.timeoutMs = timeoutMs || 5000;
    this.onCommand = onCommand || (() => {});
    this.counters = new Map();
  }

  counterFor(printerId) {
    if (!this.counters.has(printerId)) {
      this.counters.set(printerId, { Q: 0, E: 0, M: 0, U: 0, total: 0 });
    }
    return this.counters.get(printerId);
  }

  getCounters() {
    return Object.fromEntries([...this.counters.entries()].map(([id, value]) => [id, { ...value }]));
  }

  resetCounters() {
    this.counters.clear();
  }

  sendCommand({ printerId, ip, port, command, timeoutMs = this.timeoutMs }) {
    const type = command[0] || 'total';
    const counters = this.counterFor(printerId || `${ip}:${port}`);
    if (type in counters) counters[type] += 1;
    counters.total += 1;
    this.onCommand({ printerId, ip, port, command });

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const chunks = [];
      let settled = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        error ? reject(error) : resolve(value);
      };

      socket.setTimeout(timeoutMs);
      socket.on('connect', () => socket.write(buildPacket(command)));
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        const data = Buffer.concat(chunks);
        if (data.length >= 3 && (/^[!$][0-9A-F]{2}$/i.test(data.toString('ascii')) || data.at(-1) === 0x03)) {
          finish(null, decodeResponse(data));
        }
      });
      socket.on('timeout', () => finish(new Error(`Printer did not respond within ${timeoutMs} ms.`)));
      socket.on('error', (error) => finish(error));
      socket.on('close', () => {
        if (!settled) {
          const data = Buffer.concat(chunks);
          if (data.length) finish(null, decodeResponse(data));
          else finish(new Error('Printer closed the connection without replying.'));
        }
      });
      socket.connect(port, ip);
    });
  }
}

export { WsiClient, buildPacket, decodeResponse };

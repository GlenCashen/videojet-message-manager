import net from 'node:net';
import { decodeStatus, encodeStatus, faultDefinitions } from './wsi-status.js';

function packetResponse(value) {
  return Buffer.concat([Buffer.from([0x02]), Buffer.from(value, 'ascii'), Buffer.from([0x03])]);
}

function acknowledgement(command, ok = true) {
  const sum = [...Buffer.from(command, 'ascii')].reduce((total, byte) => (total + byte) & 0xFF, 0);
  return Buffer.from(`${ok ? '$' : '!'}${sum.toString(16).padStart(2, '0').toUpperCase()}`, 'ascii');
}

function initialState() {
  return {
    selectedMessage: '9 MONTH',
    availableMessages: ['9 MONTH', '12 MONTH'],
    userFields: { TEST: 'TEST123', BREW: 'BR1246', BATCH: 'B260617A' },
    status: '0000002',
    softwarePartNumber: '1.0.484.0       ',
    printCounter: 2141608,
    productCounter: 0,
    responseDelayMs: 40,
    enabled: true,
    failNextCommand: false
  };
}

class EmulatorManager {
  constructor({ host = '127.0.0.1', portOffset = 0, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onError = console.error } = {}) {
    this.host = host;
    this.portOffset = portOffset;
    this.delay = delay;
    this.onError = onError;
    this.states = new Map();
    this.listeners = new Map();
    this.printers = new Map();
  }

  endpoint(printer) {
    return { ip: this.host, port: Number(printer.port) + this.portOffset };
  }

  state(printerId) {
    if (!this.states.has(printerId)) this.states.set(printerId, initialState());
    return this.states.get(printerId);
  }

  snapshot(printerId) {
    const printer = this.printers.get(printerId);
    if (!printer) throw new Error(`Emulator printer ${printerId} was not found.`);
    const state = this.state(printerId);
    const decoded = decodeStatus(state.status);
    const endpoint = this.endpoint(printer);
    return {
      printerId,
      printerName: printer.name,
      host: endpoint.ip,
      port: endpoint.port,
      selectedMessage: state.selectedMessage,
      availableMessages: [...state.availableMessages],
      userFields: { ...state.userFields },
      status: state.status,
      alarm: decoded.alarm?.primary || 'none',
      activeFaultCodes: decoded.activeFaults.map((fault) => fault.code),
      availableFaults: faultDefinitions().filter((fault) => fault.code !== 'RESERVED_FAULT_BIT'),
      printCounter: state.printCounter,
      productCounter: state.productCounter,
      responseDelayMs: state.responseDelayMs,
      enabled: state.enabled,
      failNextCommand: state.failNextCommand
    };
  }

  update(printerId, body = {}) {
    const state = this.state(printerId);
    if (typeof body.selectedMessage === 'string' && state.availableMessages.includes(body.selectedMessage)) {
      state.selectedMessage = body.selectedMessage;
    }
    if (typeof body.status === 'string' && /^[0-9A-F]{7}$/i.test(body.status)) state.status = body.status.toUpperCase();
    if (body.faultCodes !== undefined || body.alarm !== undefined) {
      const current = this.snapshot(printerId);
      state.status = encodeStatus({
        faultCodes: body.faultCodes ?? current.activeFaultCodes,
        alarm: body.alarm ?? current.alarm
      });
    }
    if (Number.isInteger(body.responseDelayMs) && body.responseDelayMs >= 0 && body.responseDelayMs <= 10000) {
      state.responseDelayMs = body.responseDelayMs;
    }
    if (typeof body.enabled === 'boolean') state.enabled = body.enabled;
    if (typeof body.failNextCommand === 'boolean') state.failNextCommand = body.failNextCommand;
    if (body.userFields && typeof body.userFields === 'object' && !Array.isArray(body.userFields)) {
      for (const [name, value] of Object.entries(body.userFields)) {
        if (/^[\x20-\x7E]{1,30}$/.test(name) && typeof value === 'string' && value.length <= 50) state.userFields[name] = value;
      }
    }
    return this.snapshot(printerId);
  }

  reset(printerId) {
    this.states.set(printerId, initialState());
    return this.snapshot(printerId);
  }

  handleCommand(printerId, command) {
    const state = this.state(printerId);
    if (state.failNextCommand) {
      state.failNextCommand = false;
      return acknowledgement(command, false);
    }
    const type = command[0];
    const data = command.slice(1);
    switch (type) {
      case 'Q': return packetResponse(state.selectedMessage);
      case 'E': return packetResponse(state.status);
      case 'H': return packetResponse(state.softwarePartNumber);
      case 'M':
        if (!state.availableMessages.includes(data)) return acknowledgement(command, false);
        state.selectedMessage = data;
        return acknowledgement(command, true);
      case 'U': {
        const separator = data.indexOf('\n');
        if (separator < 1) return acknowledgement(command, false);
        const fieldName = data.slice(0, separator);
        const fieldValue = data.slice(separator + 1);
        if (!(fieldName in state.userFields) || fieldValue.length < 1 || fieldValue.length > 50) return acknowledgement(command, false);
        state.userFields[fieldName] = fieldValue;
        return acknowledgement(command, true);
      }
      case 'D':
        if (!(data in state.userFields)) return acknowledgement(command, false);
        state.userFields[data] = '';
        return acknowledgement(command, true);
      case 'G': {
        const value = data.toUpperCase() === 'A' ? state.printCounter : state.productCounter;
        return packetResponse(String(value).padStart(10, '0'));
      }
      case 'O': return acknowledgement(command, data === '0' || data === '1');
      default: return acknowledgement(command, false);
    }
  }

  async start(printer) {
    const endpoint = this.endpoint(printer);
    const existing = this.listeners.get(printer.id);
    if (existing && existing.port === endpoint.port) return;
    if (existing) await this.stop(printer.id);
    this.state(printer.id);

    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const start = buffer.indexOf(0x02);
        const end = buffer.indexOf(0x03, start + 1);
        if (start < 0 || end < 0) return;
        const command = buffer.subarray(start + 1, end).toString('ascii');
        const state = this.state(printer.id);
        await this.delay(state.responseDelayMs);
        if (!state.enabled) return socket.destroy();
        socket.end(this.handleCommand(printer.id, command));
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint.port, endpoint.ip, resolve);
    });
    server.removeAllListeners('error');
    server.on('error', (error) => this.onError(`WSI emulator ${printer.id} failed on ${endpoint.ip}:${endpoint.port}: ${error.message}`));
    this.listeners.set(printer.id, { server, port: endpoint.port });
  }

  async stop(printerId) {
    const listener = this.listeners.get(printerId);
    if (!listener) return;
    this.listeners.delete(printerId);
    await new Promise((resolve) => listener.server.close(resolve));
  }

  async sync(printers) {
    const emulatorPrinters = printers.filter((printer) => printer.mode === 'emulator');
    const activeIds = new Set(emulatorPrinters.map((printer) => printer.id));
    for (const printerId of [...this.listeners.keys()]) {
      if (!activeIds.has(printerId)) await this.stop(printerId);
    }
    this.printers = new Map(emulatorPrinters.map((printer) => [printer.id, printer]));
    for (const printer of emulatorPrinters) await this.start(printer);
    for (const printerId of [...this.states.keys()]) {
      if (!activeIds.has(printerId)) this.states.delete(printerId);
    }
  }

  async close() {
    for (const printerId of [...this.listeners.keys()]) await this.stop(printerId);
  }
}

export { EmulatorManager, initialState };

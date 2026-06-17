function subscribeToPrinterEvents(handlers = {}) {
  if (!('EventSource' in window)) {
    handlers.onDisconnected?.({ reason: 'unsupported' });
    return null;
  }

  const source = new EventSource('/api/events');

  source.addEventListener('open', () => {
    handlers.onConnected?.();
  });

  source.addEventListener('heartbeat', () => {
    handlers.onHeartbeat?.();
  });

  source.addEventListener('error', () => {
    handlers.onDisconnected?.({ reason: 'connection-lost' });
    handlers.onError?.();
  });

  source.addEventListener('printer-status', (event) => {
    const message = JSON.parse(event.data);
    handlers.onPrinterStatus?.(message.payload);
  });

  source.addEventListener('status-snapshot', (event) => {
    const message = JSON.parse(event.data);
    handlers.onStatusSnapshot?.(message.payload);
  });

  source.addEventListener('operation-started', (event) => {
    const message = JSON.parse(event.data);
    handlers.onPrinterStatus?.(message.payload);
    handlers.onOperationStarted?.(message.payload);
  });

  source.addEventListener('operation-completed', (event) => {
    const message = JSON.parse(event.data);
    handlers.onPrinterStatus?.(message.payload);
    handlers.onOperationCompleted?.(message.payload);
  });

  source.addEventListener('operation-failed', (event) => {
    const message = JSON.parse(event.data);
    handlers.onPrinterStatus?.(message.payload);
    handlers.onOperationFailed?.(message.payload);
  });

  source.addEventListener('printer-config', (event) => {
    const message = JSON.parse(event.data);
    handlers.onPrinterConfig?.(message.payload);
  });

  source.addEventListener('fleet-snapshot', (event) => {
    const message = JSON.parse(event.data);
    handlers.onFleetSnapshot?.(message.payload);
  });

  source.addEventListener('logs-snapshot', (event) => {
    const message = JSON.parse(event.data);
    handlers.onLogsSnapshot?.(message.payload);
  });

  source.addEventListener('log-entry', (event) => {
    const message = JSON.parse(event.data);
    handlers.onLogEntry?.(message.payload);
  });

  source.addEventListener('emulator-snapshot', (event) => {
    const message = JSON.parse(event.data);
    handlers.onEmulatorSnapshot?.(message.payload);
  });

  source.addEventListener('stream-error', (event) => {
    const message = JSON.parse(event.data);
    handlers.onStreamError?.(message.payload);
  });

  return source;
}

export { subscribeToPrinterEvents };

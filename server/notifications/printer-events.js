function faultLabel(fault) {
  return fault?.faultLabel || fault?.label || fault?.code || fault?.faultCode || null;
}

function activeFaultLabels(status) {
  const faults = status?.decodedStatus?.activeFaults || status?.decodedStatus?.faults || [];
  return faults.map(faultLabel).filter(Boolean);
}

async function findPrinter(readPrinters, printerId) {
  try {
    const printers = await readPrinters();
    return printers.find((printer) => printer.id === printerId) || null;
  } catch (_error) {
    return null;
  }
}

function statusLabel(status) {
  return status?.decodedStatus?.alarm?.label
    || status?.decodedStatus?.operatorStatus
    || status?.decodedStatus?.operatorMessage
    || null;
}

function createPrinterNotificationEvents({
  readPrinters,
  notifyPrinterOffline,
  notifyPrinterFault,
  addLog = () => {}
} = {}) {
  async function handleStatusTransition(transition, status) {
    if (transition !== 'online -> offline' || !status?.printerId) return [];

    const printer = await findPrinter(readPrinters, status.printerId);
    try {
      return await notifyPrinterOffline({
        printer,
        printerId: status.printerId,
        lastSuccessfulAt: status.lastSuccessfulAt,
        latestAttemptAt: status.lastAttemptAt,
        detectedAt: status.lastAttemptAt,
        errorMessage: status.lastError,
        targetType: 'printer',
        targetId: status.printerId
      });
    } catch (error) {
      addLog({
        action: 'printer-offline-notification-failed',
        actor: 'System',
        targetType: 'printer',
        targetId: status.printerId,
        printerId: status.printerId,
        ok: false,
        error: error.message
      });
      return [];
    }
  }

  async function handleFaultEvents(status, events = []) {
    const activated = events.filter((event) => event.event === 'activated');
    if (!activated.length || !status?.printerId) return [];

    const printer = await findPrinter(readPrinters, status.printerId);
    const faults = activeFaultLabels(status);
    try {
      return await notifyPrinterFault({
        printer,
        printerId: status.printerId,
        status: statusLabel(status),
        faults: faults.length ? faults : activated.map(faultLabel).filter(Boolean),
        faultSummary: activated.map(faultLabel).filter(Boolean).join(', '),
        detectedAt: activated[0]?.occurredAt,
        rawStatus: status.rawStatus,
        targetType: 'printer',
        targetId: status.printerId
      });
    } catch (error) {
      addLog({
        action: 'printer-fault-notification-failed',
        actor: 'System',
        targetType: 'printer',
        targetId: status.printerId,
        printerId: status.printerId,
        ok: false,
        error: error.message
      });
      return [];
    }
  }

  return {
    handleFaultEvents,
    handleStatusTransition
  };
}

export { activeFaultLabels, createPrinterNotificationEvents };

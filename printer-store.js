import {
  createPrinter as createPrinterRecord,
  deletePrinter as deletePrinterRecord,
  listPrinters,
  replacePrinters,
  updatePrinter as updatePrinterRecord,
  validatePrinter
} from './server/repositories/printer-repository.js';

async function readPrinters() {
  return listPrinters();
}

async function writePrinters(printers) {
  return replacePrinters(printers);
}

async function updatePrinter(id, changes) {
  return updatePrinterRecord(id, changes);
}

async function createPrinter(printer) {
  return createPrinterRecord(printer);
}

async function deletePrinter(id) {
  return deletePrinterRecord(id);
}

export { createPrinter, deletePrinter, readPrinters, writePrinters, updatePrinter, validatePrinter };

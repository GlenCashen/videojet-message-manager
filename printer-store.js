import {
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

export { readPrinters, writePrinters, updatePrinter, validatePrinter };

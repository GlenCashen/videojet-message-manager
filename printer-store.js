import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'data', 'printers.json');

function validatePrinter(printer) {
  if (!printer || typeof printer !== 'object' || Array.isArray(printer)) {
    throw new Error('Printer configuration must be an object.');
  }

  const id = String(printer.id || '').trim();
  const name = String(printer.name || '').trim();
  const location = String(printer.location || '').trim();
  const host = String(printer.host || '').trim();
  const port = Number(printer.port);
  const enabled = Boolean(printer.enabled);
  const mode = printer.mode === 'emulator' ? 'emulator' : 'real';

  if (!/^[a-z0-9-]{1,50}$/i.test(id)) {
    throw new Error('Printer id must contain only letters, numbers and hyphens.');
  }
  if (!name || name.length > 80) {
    throw new Error('Printer name must be 1-80 characters.');
  }
  if (location.length > 120) {
    throw new Error('Printer location must be 120 characters or fewer.');
  }
  if (!net.isIP(host) && host !== 'localhost') {
    throw new Error('Printer host must be a valid IP address or localhost.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Printer port must be between 1 and 65535.');
  }

  return { id, name, location, host, port, enabled, mode };
}

async function readPrinters() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const printers = JSON.parse(raw);

  if (!Array.isArray(printers)) {
    throw new Error('Printer configuration file must contain an array.');
  }

  return printers.map(validatePrinter);
}

async function writePrinters(printers) {
  if (!Array.isArray(printers) || printers.length > 3) {
    throw new Error('A maximum of three printers is supported.');
  }

  const validated = printers.map(validatePrinter);
  const ids = new Set(validated.map((printer) => printer.id));

  if (ids.size !== validated.length) {
    throw new Error('Printer ids must be unique.');
  }

  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return validated;
}

async function updatePrinter(id, changes) {
  const printers = await readPrinters();
  const index = printers.findIndex((printer) => printer.id === id);

  if (index < 0) {
    throw new Error(`Printer ${id} was not found.`);
  }

  printers[index] = validatePrinter({ ...printers[index], ...changes, id });
  return writePrinters(printers);
}

export { readPrinters, writePrinters, updatePrinter };

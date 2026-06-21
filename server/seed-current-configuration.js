import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { validateMessages } from './message-store.js';
import { replaceMessages } from './repositories/message-repository.js';
import { replacePrinters, validatePrinter } from './repositories/printer-repository.js';
import { resolveMessageUserFields } from './repositories/printer-user-field-repository.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = (name) => path.join(__dirname, '..', 'data', name);

async function readConfiguration(name) {
  return JSON.parse(await fs.readFile(dataPath(name), 'utf8'));
}

async function seedCurrentConfiguration(db = getDb()) {
  let printers = db.prepare('SELECT COUNT(*) count FROM printers').get().count;
  let messages = db.prepare('SELECT COUNT(*) count FROM messages').get().count;
  if (printers && messages) return { printers: 0, messages: 0 };

  const configuredPrinters = (await readConfiguration('printers.json')).map(validatePrinter);
  if (!printers) {
    replacePrinters(configuredPrinters, db);
    printers = configuredPrinters.length;
  }
  if (!messages) {
    const configuredMessages = validateMessages(await readConfiguration('messages.json'), { printers: configuredPrinters })
      .map((message) => resolveMessageUserFields(message, db));
    replaceMessages(configuredMessages, db);
    messages = configuredMessages.length;
  }
  return { printers, messages };
}

export { seedCurrentConfiguration };

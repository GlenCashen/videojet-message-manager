import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { buildProductCatalog, importProductCatalog, readProductCatalog } from './product-catalog-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultCsv = path.join(__dirname, '..', 'extracted_product_masters (1).csv');
const csvPath = path.resolve(process.argv[2] || defaultCsv);

try {
  const db = getDb();
  const rows = await readProductCatalog(csvPath);
  const printers = db.prepare('SELECT id, name, enabled FROM printers ORDER BY id').all().map((printer) => ({
    ...printer,
    enabled: Boolean(printer.enabled)
  }));
  const catalog = buildProductCatalog(rows, printers);
  const result = importProductCatalog(catalog, { db });
  console.log(JSON.stringify({ csvPath, rows: rows.length, messages: catalog.messages.length, masters: catalog.masters.length, ...result }, null, 2));
} catch (error) {
  console.error(`Product catalog import failed: ${error.message}`);
  process.exitCode = 1;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePrinterModel, printerCapabilities } from '../server/printer-capabilities.js';

test('1620 and 1710 capability profiles reflect the WSI command table', () => {
  assert.equal(printerCapabilities('1620').currentMessageReadback, true);
  assert.equal(printerCapabilities('1620').commandErrorResponse, true);
  assert.equal(printerCapabilities('1710').currentMessageReadback, false);
  assert.equal(printerCapabilities('1710').commandErrorResponse, false);
});

test('printer model defaults to 1620 and rejects unknown models', () => {
  assert.equal(normalizePrinterModel(), '1620');
  assert.throws(() => normalizePrinterModel('9999'), /1620 or 1710/);
});

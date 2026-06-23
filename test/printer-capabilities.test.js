import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePrinterModel, normalizePrinterProtocol, normalizeReadbackMode, printerCapabilities } from '../server/printer-capabilities.js';

test('1620 and 1710 capability profiles reflect the WSI command table', () => {
  assert.equal(printerCapabilities('1620').currentMessageReadback, true);
  assert.equal(printerCapabilities('1620').commandErrorResponse, true);
  assert.equal(printerCapabilities('1710').currentMessageReadback, null);
  assert.equal(printerCapabilities('1710').commandErrorResponse, false);
  assert.equal(printerCapabilities('1710', 'enabled').currentMessageReadback, true);
  assert.equal(printerCapabilities('1620', 'disabled').currentMessageReadback, false);
});

test('printer model defaults to 1620 and rejects unknown models', () => {
  assert.equal(normalizePrinterModel(), '1620');
  assert.throws(() => normalizePrinterModel('9999'), /1620 or 1710/);
  assert.equal(normalizeReadbackMode(), 'auto');
  assert.throws(() => normalizeReadbackMode('sometimes'), /auto, enabled or disabled/);
});

test('NGPCL protocol reports confirmed readback capability', () => {
  const capabilities = printerCapabilities('1620', 'auto', 'ngpcl');
  assert.equal(capabilities.protocol, 'ngpcl');
  assert.equal(capabilities.currentMessageReadback, true);
  assert.equal(capabilities.fieldReadback, true);
  assert.equal(normalizePrinterProtocol(), 'wsi');
  assert.throws(() => normalizePrinterProtocol('serial'), /wsi or ngpcl/);
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadPrinterState,
  persistedRecordFromExpected,
  restoredExpectedOutput,
  savePrinterState
} from '../server/printer-state-store.js';

test('persists and restores expected output records', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'printer-state-'));
  const file = path.join(dir, 'printer-state.json');
  const expected = {
    messageId: '12-month',
    displayName: '12 Month',
    printerMessageName: '12 MONTH',
    fields: { brew: 'BR1246', batch: 'B260617A' },
    lines: ['BR1246 B260617A'],
    rendered: 'BR1246 B260617A',
    generatedAt: '2026-06-17T04:32:08.000Z',
    source: 'last-applied'
  };

  await savePrinterState({ 'coder-1': persistedRecordFromExpected(expected) }, file);
  const raw = await readFile(file, 'utf8');
  assert.match(raw, /coder-1/);

  const records = await loadPrinterState(file);
  assert.equal(records['coder-1'].printerMessageName, '12 MONTH');
  assert.deepEqual(restoredExpectedOutput(records['coder-1']), {
    ...expected,
    generatedAt: expected.generatedAt,
    source: 'last-known'
  });
});

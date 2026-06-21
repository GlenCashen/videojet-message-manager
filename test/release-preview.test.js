import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseExpectedOutput } from '../public/js/release-preview.js';

test('release preview resolves the printer-specific approved message definition', () => {
  const result = releaseExpectedOutput({
    plannedProductionAt: '2026-06-21T04:05:06.000Z',
    brewSheetProduct: 'TBUNDRC-50',
    brewNumber: '477',
    productMasterSpecification: {
      printerConfigurations: [{
        printerId: 'coder-1',
        fieldMappings: [{ fieldKey: 'run', source: 'run_code' }, { fieldKey: 'batch', source: 'brew_sheet_product' }],
        previewLines: ['{{run}} {{batch}}', 'BBD: {{bestBeforeDate}} {{productionTime}}'],
        dateRule: { months: 15, format: 'DD/MM/YYYY' },
        timeRule: { format: 'HH:mm:ss' }
      }]
    }
  }, 'coder-1');

  assert.equal(result.provisional, true);
  assert.equal(result.rendered, '[assigned when sent] TBUNDRC-50\nBBD: 21/09/2027 04:05:06');
});

test('release preview prefers the exact output recorded during execution', () => {
  const result = releaseExpectedOutput({ expectedOutput: { byPrinter: { 'coder-1': { rendered: 'T0057 FV27' } } } }, 'coder-1');
  assert.deepEqual(result, { rendered: 'T0057 FV27', provisional: false });
});

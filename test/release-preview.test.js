import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedOutputText, messageExpectedOutput, releaseExpectedOutput } from '../public/js/release-preview.js';

test('release preview resolves the printer-specific approved message definition', () => {
  const result = releaseExpectedOutput({
    plannedProductionAt: '2026-06-21T04:05:06.000Z',
    brewSheetProduct: 'TBUNDRC-50',
    brewNumber: 'H0477',
    productMasterSpecification: {
      printerConfigurations: [{
        printerId: 'coder-1',
        fieldMappings: [{ fieldKey: 'run', source: 'run_code' }, { fieldKey: 'batch', source: 'brew_sheet_product' }],
        previewLines: ['{{run}} {{batch}}', 'BBD: {{bestBeforeDate}} {{productionTime}}'],
        dateRule: { months: 15, format: 'DD/MM/YYYY' },
        timeRule: { format: 'HH:mm:ss' }
      }]
    }
  }, 'coder-1', { now: '2026-06-21T07:08:09.000Z' });

  assert.equal(result.provisional, true);
  assert.equal(result.rendered, '[assigned when sent] TBUNDRC-50\nBBD: 21/09/2027 07:08:09');
});

test('release preview keeps exact recorded output when no template metadata exists', () => {
  const result = releaseExpectedOutput({ expectedOutput: { byPrinter: { 'coder-1': { rendered: 'T0057 FV27' } } } }, 'coder-1');
  assert.deepEqual(result, { rendered: 'T0057 FV27', provisional: false });
});

test('expected output text can update the time from stored template metadata', () => {
  const text = expectedOutputText({
    rendered: 'T0057 FV27\nBBD: 21/09/2027 04:05:06',
    plannedProductionAt: '2026-06-21T04:05:06.000Z',
    runCode: 'T0057',
    fields: { run: 'T0057', batch: 'FV27' },
    configuration: {
      fieldMappings: [{ fieldKey: 'run', source: 'run_code' }, { fieldKey: 'batch', source: 'brew_sheet_product' }],
      previewLines: ['{{run}} {{batch}}', 'BBD: {{bestBeforeDate}} {{productionTime}}'],
      dateRule: { months: 15, format: 'DD/MM/YYYY' },
      timeRule: { format: 'HH:mm:ss' }
    }
  }, 'coder-1', { now: '2026-06-21T07:08:09.000Z' });

  assert.equal(text, 'T0057 FV27\nBBD: 21/09/2027 07:08:09');
});

test('manual message preview preserves line format and updates the clock', () => {
  const preview = messageExpectedOutput({
    id: 'message-1',
    displayName: 'Message 1',
    fields: [{ key: 'batch' }],
    previewLines: ['{{batch}}', 'BBD: {{bestBeforeDate}}', '{{currentTime}}'],
    dateRule: { type: 'offset-days', days: 7, format: 'DD/MM/YYYY' },
    timeRule: { format: 'HH:mm:ss' }
  }, { batch: 'TEST' }, { productionDate: '2026-06-21T07:08:09' });

  assert.equal(preview.rendered, 'TEST\nBBD: 28/06/2026\n07:08:09');
});

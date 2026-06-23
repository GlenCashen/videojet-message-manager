import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ngpclSelectJobCommand,
  ngpclUpdateFieldsCommand,
  parseNgpclFieldResponse,
  parseNgpclJobName
} from '../server/ngpcl-protocol.js';

test('parses NGPCL job and field responses', () => {
  assert.equal(parseNgpclJobName('{~JN0|Bundy 15 Month.job|}'), 'Bundy 15 Month.job');
  assert.deepEqual(parseNgpclFieldResponse('{~FC0|Batch1|T0067|}', 'Batch1'), {
    ok: true,
    fieldName: 'Batch1',
    value: 'T0067',
    error: null,
    raw: '{~FC0|Batch1|T0067|}'
  });
  assert.equal(parseNgpclFieldResponse('{~FC1|}', 'Missing').ok, false);
});

test('builds NGPCL commands and rejects unescaped control characters', () => {
  assert.equal(ngpclSelectJobCommand('9 Months.job'), '{~JS0|9 Months.job|0|}');
  assert.equal(
    ngpclUpdateFieldsCommand([{ fieldName: 'Batch1', value: 'T0067' }, { fieldName: 'Batch', value: 'TBUNDRC-51' }]),
    '{~JU0||0|Batch1|T0067|Batch|TBUNDRC-51|}'
  );
  assert.throws(() => ngpclSelectJobCommand('Bad|Job'), /control characters/);
});

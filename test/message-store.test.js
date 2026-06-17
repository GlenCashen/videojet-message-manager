import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MessageUpdateError,
  executeMessageUpdate,
  getMessageById,
  loadMessages,
  renderPreview,
  validateMessageFields,
  validateMessages
} from '../server/message-store.js';

const definitions = [
  {
    id: '9-month',
    displayName: '9 Month',
    printerMessageName: '9 MONTH',
    enabled: true,
    fields: [
      { key: 'brew', label: 'Brew code', printerFieldName: 'BREW', required: true, maxLength: 30 },
      { key: 'batch', label: 'Batch code', printerFieldName: 'BATCH', required: true, maxLength: 30 }
    ],
    dateRule: { type: 'offset-months', months: 9 },
    previewLines: ['{{brew}} {{batch}}', 'BBD: {{bestBeforeDate}} {{currentTime}}']
  },
  {
    id: '12-month',
    displayName: '12 Month',
    printerMessageName: '12 MONTH',
    enabled: true,
    fields: [
      { key: 'brew', label: 'Brew code', printerFieldName: 'BREW', required: true, maxLength: 30 },
      { key: 'batch', label: 'Batch code', printerFieldName: 'BATCH', required: true, maxLength: 30 }
    ],
    dateRule: { type: 'offset-months', months: 12 },
    previewLines: ['{{brew}} {{batch}}', 'BBD: {{bestBeforeDate}} {{currentTime}}']
  }
];

function response(kind, value = '$00') {
  return { kind, value };
}

function updateArgs(overrides = {}) {
  const message = getMessageById(definitions, '12-month');
  const commands = [];
  return {
    commands,
    args: {
      printer: { id: 'coder-1', name: 'Can Coder', location: 'Line', host: '127.0.0.1', port: 3100, mode: 'emulator', enabled: true },
      target: { ip: '127.0.0.1', port: 3100 },
      message,
      fields: { brew: 'BR1246', batch: 'B260617A' },
      operationId: 'op-1',
      delay: async () => {},
      now: (() => {
        let value = 1000;
        return () => value += 50;
      })(),
      applySuccess: (status) => ({
        printerId: 'coder-1',
        online: true,
        revision: 4,
        lastSuccessfulAt: '2026-06-17T04:32:08.000Z',
        decodedStatus: { valid: true, faults: [], alarm: { label: 'Amber' } },
        ...status
      }),
      sendCommand: async ({ command }) => {
        commands.push(command);
        if (command === 'Q') return response('packet', overrides.selectedMessage || '12 MONTH');
        if (command === 'E') return response('packet', '0000002');
        return response('ack');
      },
      ...overrides
    }
  };
}

test('loads and validates message JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'messages-'));
  const file = path.join(dir, 'messages.json');
  await writeFile(file, JSON.stringify(definitions), 'utf8');
  const messages = await loadMessages(file);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].printerMessageName, '9 MONTH');
});

test('rejects duplicate IDs', () => {
  assert.throws(() => validateMessages([definitions[0], { ...definitions[1], id: '9-month' }]), /Duplicate message id/);
});

test('rejects duplicate printer names', () => {
  assert.throws(() => validateMessages([definitions[0], { ...definitions[1], printerMessageName: '9 MONTH' }]), /Duplicate printer message name/);
});

test('rejects unknown message ID', () => {
  assert.throws(() => getMessageById(definitions, 'unknown'), /Message unknown was not found/);
});

test('validates required and unknown fields', () => {
  const message = getMessageById(definitions, '9-month');
  assert.throws(() => validateMessageFields(message, { brew: 'BR1246' }), /Batch code is required/);
  assert.throws(() => validateMessageFields(message, { brew: 'BR1246', batch: 'B260617A', extra: 'nope' }), /Unknown field extra/);
});

test('renders 9-month preview', () => {
  const message = getMessageById(definitions, '9-month');
  const preview = renderPreview(message, { brew: 'BR1246', batch: 'B260617A' }, { productionDate: '2026-06-17T14:32:08+10:00' });
  assert.equal(preview.bestBeforeDate, '17/03/2027');
  assert.equal(preview.currentTime, '14:32:08');
  assert.deepEqual(preview.lines, ['BR1246 B260617A', 'BBD: 17/03/2027 14:32:08']);
});

test('renders 12-month preview', () => {
  const message = getMessageById(definitions, '12-month');
  const preview = renderPreview(message, { brew: 'BR1246', batch: 'B260617A' }, { productionDate: '2026-06-17T14:32:08+10:00' });
  assert.equal(preview.bestBeforeDate, '17/06/2027');
  assert.equal(preview.rendered, 'BR1246 B260617A\nBBD: 17/06/2027 14:32:08');
});

test('clamps month-end dates', () => {
  const message = { ...definitions[0], dateRule: { type: 'offset-months', months: 1 } };
  const preview = renderPreview(message, { brew: 'BR1246', batch: 'B260617A' }, { productionDate: '2023-01-31T08:00:00+10:00' });
  assert.equal(preview.bestBeforeDate, '28/02/2023');
});

test('handles leap-year month-end dates', () => {
  const message = { ...definitions[0], dateRule: { type: 'offset-months', months: 1 } };
  const preview = renderPreview(message, { brew: 'BR1246', batch: 'B260617A' }, { productionDate: '2024-01-31T08:00:00+10:00' });
  assert.equal(preview.bestBeforeDate, '29/02/2024');
});

test('sends multi-field WSI commands in order', async () => {
  const { args, commands } = updateArgs();
  const result = await executeMessageUpdate(args);
  assert.deepEqual(commands, ['UBREW\nBR1246', 'UBATCH\nB260617A', 'M12 MONTH', 'Q', 'E']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.fieldResults, [
    { key: 'brew', printerFieldName: 'BREW', acknowledged: true },
    { key: 'batch', printerFieldName: 'BATCH', acknowledged: true }
  ]);
});

test('stops on field ACK failure', async () => {
  const message = getMessageById(definitions, '12-month');
  const commands = [];
  await assert.rejects(
    executeMessageUpdate({
      ...updateArgs().args,
      message,
      sendCommand: async ({ command }) => {
        commands.push(command);
        if (command.startsWith('UBATCH')) return response('nack', '!00');
        return response('ack');
      }
    }),
    (error) => {
      assert.equal(error instanceof MessageUpdateError, true);
      assert.equal(error.result.messageSelection, 'Not attempted');
      assert.deepEqual(error.result.fieldResults, [
        { key: 'brew', printerFieldName: 'BREW', acknowledged: true },
        { key: 'batch', printerFieldName: 'BATCH', acknowledged: false }
      ]);
      return true;
    }
  );
  assert.deepEqual(commands, ['UBREW\nBR1246', 'UBATCH\nB260617A']);
});

test('reports message selection mismatch', async () => {
  const { args } = updateArgs({ selectedMessage: '9 MONTH' });
  const result = await executeMessageUpdate(args);
  assert.equal(result.ok, false);
  assert.equal(result.messageMatches, false);
  assert.equal(result.requestedMessage, '12 MONTH');
  assert.equal(result.selectedMessage, '9 MONTH');
});

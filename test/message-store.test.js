import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoderQueue } from '../server/coder-queue.js';
import {
  MessageUpdateError,
  executeMessageUpdate,
  getMessageById,
  loadMessages,
  renderPreview,
  validateMessageFields,
  validateMessages,
  getMessageForPrinter,
  messagesForPrinter
} from '../server/message-store.js';
import { StatusCache } from '../server/status-cache.js';

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

test('rejects duplicate printer assignment', () => {
  assert.throws(() => validateMessages([{
    ...definitions[0],
    printerAssignments: [
      { printerId: 'coder-1', printerMessageName: '9 MONTH', enabled: true },
      { printerId: 'coder-1', printerMessageName: '9 MONTH', enabled: true }
    ]
  }]), /Duplicate assignment/);
});

test('rejects unknown printer assignment when printers are supplied', () => {
  assert.throws(() => validateMessages([{
    ...definitions[0],
    printerAssignments: [
      { printerId: 'missing', printerMessageName: '9 MONTH', enabled: true }
    ]
  }], { printers: [{ id: 'coder-1' }] }), /unknown printer/);
});

test('filters and resolves printer-specific assignments', () => {
  const assigned = validateMessages([{
    ...definitions[0],
    printerAssignments: [
      { printerId: 'coder-1', printerMessageName: 'CAN 9M', enabled: true },
      { printerId: 'coder-2', printerMessageName: 'BBD 9M', enabled: false }
    ]
  }], { printers: [{ id: 'coder-1' }, { id: 'coder-2' }] });

  assert.equal(messagesForPrinter(assigned, 'coder-1').length, 1);
  assert.equal(messagesForPrinter(assigned, 'coder-2').length, 0);
  assert.equal(getMessageForPrinter(assigned, '9-month', 'coder-1').printerMessageName, 'CAN 9M');
  assert.throws(() => getMessageForPrinter(assigned, '9-month', 'coder-2'), /not assigned/);
});

test('rejects unknown message ID', () => {
  assert.throws(() => getMessageById(definitions, 'unknown'), /Message unknown was not found/);
});

test('validates required and unknown fields', () => {
  const message = getMessageById(definitions, '9-month');
  assert.throws(() => validateMessageFields(message, { brew: 'BR1246' }), /Batch code is required/);
  assert.throws(() => validateMessageFields(message, { brew: 'BR1246', batch: 'B260617A', extra: 'nope' }), /Unknown field extra/);
});

test('normalizes uppercase by default and preserves transform none', () => {
  const message = {
    ...getMessageById(definitions, '9-month'),
    fields: [
      { key: 'brew', label: 'Brew code', printerFieldName: 'BREW', required: true, maxLength: 30 },
      { key: 'batch', label: 'Batch code', printerFieldName: 'BATCH', required: true, maxLength: 30, transform: 'none' }
    ]
  };
  assert.deepEqual(validateMessageFields(message, { brew: 'br1246', batch: 'b260617a' }), {
    brew: 'BR1246',
    batch: 'b260617a'
  });
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
  assert.deepEqual(result.expectedOutput.fields, { brew: 'BR1246', batch: 'B260617A' });
  assert.equal(result.expectedOutput.printerMessageName, '12 MONTH');
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
        if (command === 'Q') return response('packet', '12 MONTH');
        if (command === 'E') return response('packet', '0000002');
        return response('ack');
      }
    }),
    (error) => {
      assert.equal(error instanceof MessageUpdateError, true);
      assert.equal(error.code, 'FIELD_UPDATE_REJECTED');
      assert.equal(error.communicationSucceeded, true);
      assert.equal(error.result.printerOnline, true);
      assert.equal(error.result.messageSelection, 'Not attempted');
      assert.deepEqual(error.result.fieldResults, [
        { key: 'brew', printerFieldName: 'BREW', acknowledged: true },
        {
          key: 'batch',
          printerFieldName: 'BATCH',
          acknowledged: false,
          error: 'Printer rejected field update'
        }
      ]);
      assert.equal(error.result.status.online, true);
      assert.equal(error.result.selectedMessage, '12 MONTH');
      return true;
    }
  );
  assert.deepEqual(commands, ['UBREW\nBR1246', 'UBATCH\nB260617A', 'Q', 'E']);
});

test('reports message selection mismatch', async () => {
  const { args } = updateArgs({ selectedMessage: '9 MONTH' });
  const result = await executeMessageUpdate(args);
  assert.equal(result.ok, false);
  assert.equal(result.messageMatches, false);
  assert.equal(result.requestedMessage, '12 MONTH');
  assert.equal(result.selectedMessage, '9 MONTH');
});

test('field NACK refresh preserves cache online state and failures', async () => {
  const cache = new StatusCache({ staleAfterMs: 1000, offlineAfterFailures: 3 });
  cache.syncPrinters([{ id: 'coder-1' }]);
  cache.applySuccess('coder-1', { selectedMessage: 'TEST', rawStatus: '0000002', responseTimeMs: 10 });
  const before = cache.get('coder-1');
  const commands = [];

  await assert.rejects(
    executeMessageUpdate({
      ...updateArgs().args,
      applySuccess: (status) => cache.applySuccess('coder-1', status),
      sendCommand: async ({ command }) => {
        commands.push(command);
        if (command === 'UBREW\nBR1246') return response('nack', '!00');
        if (command === 'Q') return response('packet', 'TEST');
        if (command === 'E') return response('packet', '0000002');
        return response('ack');
      }
    }),
    MessageUpdateError
  );

  const after = cache.get('coder-1');
  assert.deepEqual(commands, ['UBREW\nBR1246', 'Q', 'E']);
  assert.equal(after.online, true);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.selectedMessage, 'TEST');
  assert.equal(after.rawStatus, '0000002');
  assert.equal(after.lastError, null);
});

test('failed refresh can follow normal failure threshold policy', async () => {
  const cache = new StatusCache({ staleAfterMs: 1000, offlineAfterFailures: 2 });
  cache.syncPrinters([{ id: 'coder-1' }]);
  cache.applySuccess('coder-1', { selectedMessage: 'TEST', rawStatus: '0000002', responseTimeMs: 10 });

  await assert.rejects(
    executeMessageUpdate({
      ...updateArgs().args,
      applySuccess: (status) => cache.applySuccess('coder-1', status),
      sendCommand: async ({ command }) => {
        if (command === 'UBREW\nBR1246') return response('nack', '!00');
        if (command === 'Q') throw new Error('Printer did not respond within 5000 ms.');
        return response('ack');
      }
    }),
    (error) => {
      assert.equal(error instanceof MessageUpdateError, true);
      assert.equal(error.communicationSucceeded, false);
      cache.applyFailure('coder-1', error.refreshError || error);
      return true;
    }
  );

  assert.equal(cache.get('coder-1').online, true);
  assert.equal(cache.get('coder-1').consecutiveFailures, 1);
  cache.applyFailure('coder-1', new Error('second timeout'));
  assert.equal(cache.get('coder-1').online, false);
});

test('queue releases after field NACK and subsequent valid update succeeds', async () => {
  const queue = new CoderQueue();
  let rejectFirst = true;

  await assert.rejects(queue.run('coder-1', { operation: 'message-update' }, async () => {
    const commands = [];
    return executeMessageUpdate({
      ...updateArgs().args,
      sendCommand: async ({ command }) => {
        commands.push(command);
        if (rejectFirst && command === 'UBREW\nBR1246') {
          rejectFirst = false;
          return response('nack', '!00');
        }
        if (command === 'Q') return response('packet', 'TEST');
        if (command === 'E') return response('packet', '0000002');
        return response('ack');
      }
    });
  }), MessageUpdateError);

  assert.equal(queue.isBusy('coder-1'), false);

  const result = await queue.run('coder-1', { operation: 'message-update' }, async () =>
    executeMessageUpdate(updateArgs().args)
  );
  assert.equal(result.ok, true);
  assert.equal(result.selectedMessage, '12 MONTH');
});

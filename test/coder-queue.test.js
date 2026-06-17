import assert from 'node:assert/strict';
import test from 'node:test';
import { CoderQueue } from '../server/coder-queue.js';

test('orders operations for the same coder', async () => {
  const queue = new CoderQueue();
  const events = [];
  await Promise.all([
    queue.run('coder-1', { operation: 'a' }, async () => {
      events.push('a-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('a-end');
    }),
    queue.run('coder-1', { operation: 'b' }, async () => {
      events.push('b-start');
      events.push('b-end');
    })
  ]);
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('releases queue after thrown error', async () => {
  const queue = new CoderQueue();
  await assert.rejects(queue.run('coder-1', { operation: 'bad' }, async () => {
    throw new Error('boom');
  }));
  assert.equal(queue.isBusy('coder-1'), false);
  const value = await queue.run('coder-1', { operation: 'good' }, async () => 42);
  assert.equal(value, 42);
});

test('allows different coders to operate independently', async () => {
  const queue = new CoderQueue();
  const events = [];
  await Promise.all([
    queue.run('coder-1', { operation: 'slow' }, async () => {
      events.push('coder-1-start');
      await new Promise((resolve) => setTimeout(resolve, 25));
      events.push('coder-1-end');
    }),
    queue.run('coder-2', { operation: 'fast' }, async () => {
      events.push('coder-2');
    })
  ]);
  assert.equal(events.includes('coder-2'), true);
});

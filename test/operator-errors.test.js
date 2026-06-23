import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorNoticeText, operatorErrorMessage } from '../public/js/operator-errors.js';

test('operatorNoticeText replaces stale WSI detail with operator action', () => {
  const message = 'Printer status is stale. Waiting for a fresh server update. Latest WSI error: Printer did not respond to Q at 192.168.100.166:3100 within 5000 ms.';

  assert.equal(
    operatorNoticeText(message),
    'Can’t confirm the coder right now. Showing the last known status. Check the coder is powered on and connected to the network, then press Check status. If this keeps happening, call maintenance.'
  );
});

test('operatorErrorMessage replaces printer timeout detail', () => {
  assert.equal(
    operatorErrorMessage('Printer did not respond to Q at 192.168.100.166:3100 within 5000 ms.'),
    'The coder did not reply. Check the coder is powered on and connected to the network, then press Check status.'
  );
});

test('operatorErrorMessage keeps non-technical messages unchanged', () => {
  assert.equal(
    operatorErrorMessage('Enter all required fields before setting the printer.'),
    'Enter all required fields before setting the printer.'
  );
});

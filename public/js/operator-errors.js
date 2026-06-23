const OPERATOR_DEFAULT_MESSAGE = 'Something went wrong while checking the coder. Try again or call maintenance.';

function rawErrorText(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message || '');
  return String(error || '');
}

function operatorErrorMessage(error, { fallback = OPERATOR_DEFAULT_MESSAGE } = {}) {
  const original = rawErrorText(error).trim();
  const text = original.toLowerCase();

  if (!original) return fallback;

  if (text.includes('printer status is stale') || text.includes('data is stale')) {
    return 'Can’t confirm the coder right now. Showing the last known status. Check the coder is powered on and connected to the network, then press Check status. If this keeps happening, call maintenance.';
  }

  if (text.includes('did not respond') || text.includes('timeout') || text.includes('timed out')) {
    return 'The coder did not reply. Check the coder is powered on and connected to the network, then press Check status.';
  }

  if (text.includes('closed the connection') || text.includes('connection reset')) {
    return 'The coder connection dropped out. Wait a few seconds, then press Check status.';
  }

  if (text.includes('econnrefused') || text.includes('ehostunreach') || text.includes('enetunreach') || text.includes('connect')) {
    return 'The server cannot connect to the coder. Check the coder network connection or call maintenance.';
  }

  if (text.includes('invalid current-message response') || text.includes('invalid current message response')) {
    return 'The coder replied, but the message could not be confirmed. Physically check the first print before running.';
  }

  if (text.includes('message mismatch')) {
    return original
      .replace(/MESSAGE MISMATCH/gi, 'Message mismatch')
      .replace(/Printer reports:/gi, 'Coder currently shows:');
  }

  return original;
}

function operatorNoticeText(message) {
  const original = rawErrorText(message);
  if (!original) return '';

  const technicalPatterns = [
    /Latest WSI error:/i,
    /Printer did not respond to .*? within \d+ ms/i,
    /Printer closed the connection to .*? without replying to .*?\.?/i,
    /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timeout/i,
    /Printer status is stale|Data is stale/i
  ];

  if (technicalPatterns.some((pattern) => pattern.test(original))) {
    return operatorErrorMessage(original, {
      fallback: 'Can’t confirm the coder right now. Showing the last known status. Check the coder is powered on and connected to the network, then press Check status. If this keeps happening, call maintenance.'
    });
  }

  return original;
}

function technicalErrorMessage(error) {
  return rawErrorText(error).trim();
}

export { operatorErrorMessage, operatorNoticeText, technicalErrorMessage };

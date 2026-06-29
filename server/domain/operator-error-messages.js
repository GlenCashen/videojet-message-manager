const OPERATOR_MESSAGES = {
  NGPCL_VALIDATION_FAILED: 'The message contains characters the printer cannot accept. Check the message and field values.',
  NGPCL_TIMEOUT: 'The printer did not reply in time. Check the printer power, network connection and IP address.',
  WSI_TIMEOUT: 'The printer did not reply in time. Check the printer power, network connection and IP address.',
  WSI_CONNECTION_ERROR: 'The app could not connect to the printer. Check the printer power, network connection and IP address.',
  NGPCL_PROTOCOL_ERROR: 'The printer replied in an unexpected format. Ask engineering to check the printer protocol setup.',
  WSI_PROTOCOL_ERROR: 'The printer replied in an unexpected format. Ask engineering to check the printer protocol setup.',
  MESSAGE_MISMATCH: 'The printer selected a different message than requested. Do not start production until the printer is checked.',
  FIELD_NOT_FOUND: 'The message was selected, but one of the required fields is missing on the printer.',
  FIELD_READBACK_MISMATCH: 'The printer accepted the update, but the readback did not match. Do not start production until the code is checked.',
  FIELD_UPDATE_REJECTED: 'The printer did not accept one of the field updates. Check the stored field names on the printer.',
  AGENT_RESTARTED_DURING_SEND: 'The printer agent restarted during the send. Physically check the printer before retrying.',
  AGENT_OUTPUT_MISMATCH: 'The printer agent could not verify the approved print data. Ask engineering to check the agent configuration.',
  AGENT_EXECUTION_FAILED: 'The printer agent could not complete the message change. Check the agent and printer connection.'
};

const STEP_MESSAGES = {
  validation: 'The message could not be sent because the request is not valid.',
  'message-selection': 'The printer did not accept that stored message. Check the message name on the printer and in the app.',
  'message-verification': 'The app could not confirm which message is selected on the printer.',
  'field-read': 'The app could not read the required fields from the selected message.',
  'field-update': 'The printer did not accept one of the field updates. Check the stored field names and values.',
  'field-readback': 'The printer accepted the update, but the readback did not match. Do not start production until the code is checked.',
  'status-read': 'The message may have changed, but the app could not read printer status afterward.',
  verification: 'The message may have changed, but the app could not verify the final printer state.'
};

function operatorMessageForUpdate(update = {}) {
  if (update.operatorMessage) return update.operatorMessage;
  if (['NGPCL_TIMEOUT', 'WSI_TIMEOUT', 'WSI_CONNECTION_ERROR'].includes(update.code)) return OPERATOR_MESSAGES[update.code];
  if (update.failedStep && STEP_MESSAGES[update.failedStep]) return STEP_MESSAGES[update.failedStep];
  if (update.code && OPERATOR_MESSAGES[update.code]) return OPERATOR_MESSAGES[update.code];
  if (update.messageMatches === false) return OPERATOR_MESSAGES.MESSAGE_MISMATCH;
  if (update.communicationSucceeded === false || update.printerOnline === false) {
    return 'The app could not confirm the printer state. Physically check the printer before retrying.';
  }
  if (update.ok === false) return 'The message change failed. Check the printer and try again.';
  return null;
}

function technicalMessageForUpdate(update = {}) {
  const parts = [];
  if (update.code) parts.push(update.code);
  if (update.failedStep) parts.push(`step=${update.failedStep}`);
  if (update.error) parts.push(update.error);
  if (update.requestedMessage) parts.push(`requested=${update.requestedMessage}`);
  if (update.selectedMessage) parts.push(`selected=${update.selectedMessage}`);
  if (update.rawResponse) parts.push(`rawResponse=${update.rawResponse}`);
  if (update.rawStatus) parts.push(`rawStatus=${update.rawStatus}`);
  return parts.join(' | ') || update.error || null;
}

function withOperatorError(update = {}) {
  const needsMessage = update.ok === false || update.messageMatches === false || update.error || update.code;
  if (!needsMessage) return update;
  const operatorMessage = operatorMessageForUpdate(update);
  const technicalMessage = update.technicalMessage || technicalMessageForUpdate(update) || update.error || operatorMessage;
  return {
    ...update,
    ...(operatorMessage ? { operatorMessage } : {}),
    ...(technicalMessage ? { technicalMessage } : {})
  };
}

export { operatorMessageForUpdate, technicalMessageForUpdate, withOperatorError };

const COMMAND_NAMES = {
  D: 'Clear User Field Data',
  E: 'Request Error Status',
  G: 'Request Print/Product Counter',
  H: 'Request Part Number',
  M: 'Message Select',
  O: 'Print On/Off',
  Q: 'Request Current Selected Message',
  R: 'Reset Print/Product Counter',
  U: 'Update User Field Data'
};

function commandChecksum(command) {
  const sum = [...Buffer.from(command, 'ascii')].reduce((total, byte) => (total + byte) & 0xFF, 0);
  return sum.toString(16).padStart(2, '0').toUpperCase();
}

function responseDetails(command, response) {
  const commandType = command[0] || '?';
  const responseChecksum = /^[!$][0-9A-F]{2}$/i.test(response?.value || '')
    ? response.value.slice(1).toUpperCase()
    : null;
  const expectedChecksum = commandChecksum(command);
  return {
    command: commandType,
    commandName: COMMAND_NAMES[commandType] || `WSI command ${commandType}`,
    rawCode: response?.value || null,
    rawResponseHex: response?.hex || null,
    responseChecksum,
    expectedChecksum,
    checksumMatches: responseChecksum ? responseChecksum === expectedChecksum : null
  };
}

function rejectionHint(commandType) {
  if (commandType === 'M') return 'Confirm that the requested message exists on the printer.';
  if (commandType === 'U' || commandType === 'D') return 'Confirm that the named user field exists and the supplied data is valid.';
  if (commandType === 'Q') return 'The supplied command table does not confirm Q for every 1710 firmware variant; use per-printer auto-detection or an explicit override.';
  return 'Confirm that this command is supported by the printer variant and valid in its current state.';
}

function commandRejectedError(command, response) {
  const details = responseDetails(command, response);
  const checksumNote = details.checksumMatches
    ? `${details.responseChecksum} is the command checksum, not an error number.`
    : `Response checksum ${details.responseChecksum || 'missing'} does not match expected checksum ${details.expectedChecksum}.`;
  const error = new Error(
    `Printer rejected ${details.commandName} (${details.command}). The protocol reports an unknown or failed command; ${checksumNote} ${rejectionHint(details.command)}`
  );
  error.code = 'WSI_PROTOCOL_ERROR';
  error.reasonCode = 'WSI_COMMAND_REJECTED';
  Object.assign(error, details);
  return error;
}

function unexpectedResponseError(command, response, expectedKind) {
  const details = responseDetails(command, response);
  const error = new Error(
    `Unexpected response to ${details.commandName} (${details.command}): expected ${expectedKind}, received ${response?.value || response?.kind || 'no response'}.`
  );
  error.code = 'WSI_PROTOCOL_ERROR';
  error.reasonCode = 'WSI_UNEXPECTED_RESPONSE';
  Object.assign(error, details);
  return error;
}

function assertPacketResponse(command, response) {
  if (response?.kind === 'nack') throw commandRejectedError(command, response);
  if (response?.kind !== 'packet') throw unexpectedResponseError(command, response, 'a framed data packet');
  return response;
}

function failureMessage(command, response) {
  if (response?.kind === 'nack') return commandRejectedError(command, response).message;
  return unexpectedResponseError(command, response, 'an acknowledgement').message;
}

export {
  assertPacketResponse,
  commandChecksum,
  commandRejectedError,
  failureMessage,
  responseDetails
};

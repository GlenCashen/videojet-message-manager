function responseError(message, response) {
  const error = new Error(message);
  error.code = 'WSI_PROTOCOL_ERROR';
  error.rawCode = response?.kind === 'nack' || response?.kind === 'ack' ? response.value : null;
  error.rawResponseHex = response?.hex || null;
  return error;
}

async function requestCurrentMessage(wsiClient, target) {
  const response = await wsiClient.sendCommand({ ...target, command: 'Q' });

  if (response.kind === 'nack') {
    throw responseError(`Printer rejected the current-message request (${response.value}).`, response);
  }
  if (response.kind !== 'packet') {
    throw responseError(`Unexpected current-message response: ${response.value || response.kind}.`, response);
  }

  const currentMessage = response.value.trim();
  if (!currentMessage || !/^[\x20-\x7E]+$/.test(currentMessage)) {
    throw responseError('Printer returned an invalid current-message response.', response);
  }

  return {
    currentMessage,
    rawCode: null,
    rawResponseHex: response.hex || null
  };
}

export { requestCurrentMessage };

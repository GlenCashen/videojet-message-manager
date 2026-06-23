import { assertPacketResponse } from './wsi-response.js';
import { parseNgpclJobName } from './ngpcl-protocol.js';

function responseError(message, response) {
  const error = new Error(message);
  error.code = response?.value?.startsWith?.('{~') ? 'NGPCL_PROTOCOL_ERROR' : 'WSI_PROTOCOL_ERROR';
  error.rawCode = response?.kind === 'nack' || response?.kind === 'ack' ? response.value : null;
  error.rawResponseHex = response?.hex || null;
  return error;
}

async function requestCurrentMessage(wsiClient, target) {
  if (target.protocol === 'ngpcl') {
    const response = await wsiClient.sendCommand({ ...target, command: '{~JR|}' });
    const currentMessage = parseNgpclJobName(response);
    if (!currentMessage || !/^[\x20-\x7E]+$/.test(currentMessage)) {
      throw responseError('Coder returned an invalid current-message response.', response);
    }
    return {
      currentMessage,
      rawCode: null,
      rawResponseHex: response.hex || null
    };
  }

  const response = assertPacketResponse('Q', await wsiClient.sendCommand({ ...target, command: 'Q' }));

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

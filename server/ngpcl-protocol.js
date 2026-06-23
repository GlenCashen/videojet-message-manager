const NGPCL_CONTROL_CHARS = /[|{}~]/;

function packetText(response) {
  return String(response?.value ?? response ?? '').trim();
}

function ngpclProtocolError(message, response, reasonCode = 'NGPCL_PROTOCOL_ERROR') {
  const error = new Error(message);
  error.code = 'NGPCL_PROTOCOL_ERROR';
  error.reasonCode = reasonCode;
  error.rawResponse = packetText(response);
  return error;
}

function stripPacket(response) {
  return packetText(response).replace(/^\{|\}$/g, '');
}

function splitNgpcl(response) {
  return stripPacket(response).split('|');
}

function parseNgpclJobName(response) {
  const raw = packetText(response);
  if (!raw.startsWith('{~JN0|')) {
    throw ngpclProtocolError(`Unexpected NGPCL job response: ${raw}`, response, 'NGPCL_UNEXPECTED_JOB_RESPONSE');
  }
  return splitNgpcl(raw)[1] || '';
}

function parseNgpclFieldResponse(response, expectedFieldName) {
  const raw = packetText(response);
  if (raw === '{~FC1|}') {
    return {
      ok: false,
      fieldName: expectedFieldName,
      value: null,
      error: 'Field not found or read failed',
      raw
    };
  }

  if (!raw.startsWith('{~FC0|')) {
    return {
      ok: false,
      fieldName: expectedFieldName,
      value: null,
      error: 'Unexpected field response',
      raw
    };
  }

  const parts = splitNgpcl(raw);
  return {
    ok: parts[1] === expectedFieldName,
    fieldName: parts[1] || '',
    value: parts[2] ?? '',
    error: parts[1] === expectedFieldName ? null : `Expected field ${expectedFieldName}, received ${parts[1] || 'none'}`,
    raw
  };
}

function assertNgpclAck(response, expected, label) {
  const raw = packetText(response);
  if (raw !== expected) {
    throw ngpclProtocolError(
      `Unexpected NGPCL ${label} response: expected ${expected}, received ${raw || 'no response'}.`,
      response,
      'NGPCL_UNEXPECTED_ACK'
    );
  }
  return raw;
}

function assertNgpclSafeValue(value, label) {
  const text = String(value ?? '');
  if (NGPCL_CONTROL_CHARS.test(text)) {
    throw new Error(`${label} cannot contain NGPCL control characters: | { } ~.`);
  }
  return text;
}

function ngpclSelectJobCommand(jobName) {
  return `{~JS0|${assertNgpclSafeValue(jobName, 'Message name')}|0|}`;
}

function ngpclReadFieldCommand(fieldName) {
  return `{~FR|${assertNgpclSafeValue(fieldName, 'Field name')}|}`;
}

function ngpclUpdateFieldsCommand(fieldPairs) {
  const pairs = fieldPairs.flatMap(({ fieldName, value }) => [
    assertNgpclSafeValue(fieldName, 'Field name'),
    assertNgpclSafeValue(value, `${fieldName} value`)
  ]);
  return `{~JU0||0|${pairs.join('|')}|}`;
}

export {
  assertNgpclAck,
  assertNgpclSafeValue,
  ngpclProtocolError,
  ngpclReadFieldCommand,
  ngpclSelectJobCommand,
  ngpclUpdateFieldsCommand,
  parseNgpclFieldResponse,
  parseNgpclJobName,
  splitNgpcl,
  stripPacket
};

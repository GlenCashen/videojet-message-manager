import { splitNgpcl } from './ngpcl-protocol.js';

function alarm(primary, label) {
  return {
    primary,
    label,
    green: primary === 'green',
    amber: primary === 'amber' || primary === 'yellow',
    yellow: primary === 'yellow',
    red: false,
    blue: primary === 'blue',
    off: primary === 'off',
    alarmActive: primary === 'amber' || primary === 'yellow' || primary === 'blue'
  };
}

function invalidStatus(raw) {
  return {
    valid: false,
    protocol: 'ngpcl',
    raw,
    error: 'Invalid NGPCL status response',
    activeFaults: [],
    faults: [],
    alarm: null,
    hasFaults: false
  };
}

function statusDetails({ printingFlag, beamOrStopFlag, attentionFlag, stateCode }) {
  if (stateCode === '06' && printingFlag === '1') {
    return { primary: 'green', label: 'Green', status: 'Printing', message: 'Coder is printing.' };
  }
  if (stateCode === '09' && beamOrStopFlag === '1' && attentionFlag === '1') {
    return { primary: 'blue', label: 'Blue', status: 'Beam stop active', message: 'Beam stop is active. Printing is inhibited.' };
  }
  if (stateCode === '05' && attentionFlag === '1') {
    return { primary: 'yellow', label: 'Yellow', status: 'Attention required', message: 'Coder needs attention. Check door/interlock/warnings.' };
  }
  if (stateCode === '11') {
    return { primary: 'off', label: 'Off', status: 'Idle', message: 'Coder is online but not printing.' };
  }
  if (stateCode === '02') {
    return { primary: 'off', label: 'Off', status: 'Off', message: 'Coder is off from the HMI.' };
  }
  if (stateCode === '04') {
    return { primary: 'off', label: 'Off', status: 'Stopped', message: 'Coder is stopped or not ready to print.' };
  }
  return { primary: 'amber', label: 'Amber', status: 'Unknown state', message: 'Coder is online but the state is not mapped yet.' };
}

function decodeNgpclStatus(input) {
  const raw = String(input || '').trim();
  if (!raw.startsWith('{~DS0|') || !raw.endsWith('}')) return invalidStatus(raw);

  const parts = splitNgpcl(raw);
  if (parts[0] !== '~DS0' || parts.length < 11) return invalidStatus(raw);

  const printingFlag = parts[2] || '';
  const beamOrStopFlag = parts[3] || '';
  const attentionFlag = parts[4] || '';
  const stateCode = parts[9] || '';
  const modeCode = parts[10] || '';
  const details = statusDetails({ printingFlag, beamOrStopFlag, attentionFlag, stateCode });

  return {
    valid: true,
    protocol: 'ngpcl',
    raw,
    fields: parts.slice(1, 11),
    printingFlag,
    beamOrStopFlag,
    attentionFlag,
    stateCode,
    modeCode,
    operatorStatus: details.status,
    operatorMessage: details.message,
    activeFaults: [],
    faults: [],
    hasFaults: false,
    alarm: alarm(details.primary, details.label)
  };
}

function assertValidNgpclStatus(input) {
  const decoded = decodeNgpclStatus(input);
  if (!decoded.valid) {
    const error = new Error(decoded.error);
    error.code = 'NGPCL_PROTOCOL_ERROR';
    error.rawStatus = decoded.raw;
    throw error;
  }
  return decoded;
}

export { assertValidNgpclStatus, decodeNgpclStatus };

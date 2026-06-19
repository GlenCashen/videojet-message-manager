const FAULT_MAP = [
  [
    [1, 'CHARGE_ERROR', 'Charge error'],
    [2, 'EHT_TRIP', 'EHT trip'],
    [4, 'GUTTER_FAULT', 'Gutter fault'],
    [8, 'INK_CORE_EMPTY', 'Ink core empty']
  ],
  [
    [1, 'PUMP_FAULT', 'Pump fault'],
    [2, 'CABINET_TOO_HOT', 'Cabinet too hot'],
    [4, 'INK_CORE_SERVICE_OVERDUE', 'Ink core service overdue'],
    [8, 'VISCOSITY_CONTROL_FAILED', 'Unable to control viscosity']
  ],
  [
    [1, 'BAD_NOZZLE', 'Bad nozzle'],
    [2, 'MOD_DRIVER_OVER_TEMPERATURE', 'Mod driver chip over temperature'],
    [4, 'NO_PHASE_RESPONSE', 'Fatal error: no phase response from firmware'],
    [8, 'PHASING_THRESHOLD_MINIMUM', 'Phasing threshold at minimum - no good phasing']
  ],
  [
    [1, 'PHASING_THRESHOLD_MAXIMUM', 'Phasing threshold at maximum - no good phasing'],
    [2, 'AUTO_MODULATION_FAILED', 'Auto modulation failed to obtain good phasing'],
    [4, 'INITIAL_PHASING_TRIM_FAILED', 'Initial phasing trim failed'],
    [8, 'MODULATION_READBACK_FAILED', 'Modulation readback failed']
  ],
  [
    [1, 'RASTER_MEMORY_OVERFLOW', 'Raster memory overflow'],
    [2, 'VALVE_ERROR', 'Valve error - contact service'],
    [4, 'CORE_NOT_FILLING', 'Core not filling'],
    [8, 'INSUFFICIENT_INK_TO_FILL_CORE', 'Insufficient ink to fill core']
  ],
  [
    [1, 'DATE_TIME_NOT_SET', 'Date/time not set'],
    [2, 'INK_REFERENCE_MISMATCH', 'New ink core has a different ink reference'],
    [4, 'EHT_CALIBRATION_REQUIRED', 'EHT calibration required'],
    [8, 'RESERVED_FAULT_BIT', 'Unassigned/reserved']
  ]
];

const ALARM_MASKS = { none: 0, green: 1, amber: 2, red: 4, alarm: 8 };

function faultDefinitions() {
  return FAULT_MAP.flatMap((faults, byteIndex) => faults.map(([bit, code, label]) => ({
    code,
    label,
    byte: byteIndex + 1,
    bit
  })));
}

function encodeStatus({ faultCodes = [], alarm = 'amber' } = {}) {
  if (!Array.isArray(faultCodes)) throw new Error('faultCodes must be an array.');
  if (!(alarm in ALARM_MASKS)) throw new Error(`Unknown alarm state: ${alarm}.`);

  const definitions = faultDefinitions();
  const selected = new Set(faultCodes);
  const known = new Set(definitions.map((fault) => fault.code));
  for (const code of selected) {
    if (!known.has(code)) throw new Error(`Unknown fault code: ${code}.`);
  }

  const faultMask = FAULT_MAP.map((faults) => faults.reduce(
    (mask, [bit, code]) => selected.has(code) ? mask | bit : mask,
    0
  ).toString(16).toUpperCase()).join('');
  return `${faultMask}${ALARM_MASKS[alarm].toString(16).toUpperCase()}`;
}

function invalidStatus(raw) {
  return {
    valid: false,
    raw,
    error: 'Invalid WSI status response',
    activeFaults: [],
    faults: [],
    alarm: null,
    hasFaults: false
  };
}

function decodeNibble(value, byte) {
  const numeric = Number.parseInt(value, 16);
  return FAULT_MAP[byte - 1]
    .filter(([bit]) => numeric & bit)
    .map(([bit, code, label]) => ({
      code,
      label,
      byte,
      bit,
      severity: 'fault'
    }));
}

function primaryAlarm(alarm) {
  if (alarm.red) return 'red';
  if (alarm.amber) return 'amber';
  if (alarm.green) return 'green';
  if (alarm.alarmActive) return 'alarm';
  return 'none';
}

function alarmLabel(primary) {
  switch (primary) {
    case 'red': return 'Red';
    case 'amber': return 'Amber';
    case 'green': return 'Green';
    case 'alarm': return 'Alarm active';
    default: return 'None';
  }
}

function decodeStatus(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!/^[0-9A-F]{7}$/.test(raw)) return invalidStatus(raw);

  const faultMask = raw.slice(0, 6);
  const alarmMask = raw.slice(6);
  const activeFaults = [...faultMask].flatMap((nibble, index) => decodeNibble(nibble, index + 1));
  const mask = Number.parseInt(alarmMask, 16);
  const alarmBase = {
    mask,
    green: Boolean(mask & 1),
    amber: Boolean(mask & 2),
    red: Boolean(mask & 4),
    alarmActive: Boolean(mask & 8)
  };
  const primary = primaryAlarm(alarmBase);
  const alarm = { ...alarmBase, primary, label: alarmLabel(primary) };

  return {
    valid: true,
    raw,
    faultMask,
    alarmMask,
    activeFaults,
    faults: activeFaults,
    alarm,
    hasFaults: activeFaults.length > 0
  };
}

function assertValidStatus(input) {
  const decoded = decodeStatus(input);
  if (!decoded.valid) {
    const error = new Error(decoded.error);
    error.code = 'WSI_PROTOCOL_ERROR';
    error.rawStatus = decoded.raw;
    throw error;
  }
  return decoded;
}

export { ALARM_MASKS, FAULT_MAP, assertValidStatus, decodeStatus, encodeStatus, faultDefinitions };

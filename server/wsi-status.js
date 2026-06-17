const FAULT_MAP = [
  [
    ['1', 'CHARGE_ERROR', 'Charge error'],
    ['2', 'EHT_TRIP', 'EHT trip'],
    ['4', 'GUTTER_FAULT', 'Gutter fault'],
    ['8', 'INK_CORE_EMPTY', 'Ink core empty']
  ],
  [
    ['1', 'PUMP_FAULT', 'Pump fault'],
    ['2', 'CABINET_TOO_HOT', 'Cabinet too hot'],
    ['4', 'INK_CORE_SERVICE_OVERDUE', 'Ink core service overdue'],
    ['8', 'UNABLE_TO_CONTROL_VISCOSITY', 'Unable to control viscosity']
  ],
  [
    ['1', 'BAD_NOZZLE', 'Bad nozzle'],
    ['2', 'MODULATION_DRIVER_OVER_TEMPERATURE', 'Modulation driver chip over temperature'],
    ['4', 'FATAL_NO_PHASE_RESPONSE', 'Fatal error: no phase response from firmware'],
    ['8', 'PHASING_THRESHOLD_MINIMUM', 'Phasing threshold at minimum - no good phasing']
  ],
  [
    ['1', 'PHASING_THRESHOLD_MAXIMUM', 'Phasing threshold at maximum - no good phasing'],
    ['2', 'AUTOMATIC_MODULATION_FAILED', 'Automatic modulation failed to obtain good phasing'],
    ['4', 'INITIAL_PHASING_TRIM_FAILED', 'Initial phasing trim failed'],
    ['8', 'MODULATION_READBACK_FAILED', 'Modulation readback failed']
  ],
  [
    ['1', 'RASTER_MEMORY_OVERFLOW', 'Raster memory overflow'],
    ['2', 'VALVE_ERROR', 'Valve error - contact service'],
    ['4', 'INK_CORE_NOT_FILLING', 'Ink core not filling'],
    ['8', 'INSUFFICIENT_INK_TO_FILL_CORE', 'Insufficient ink to fill core']
  ],
  [
    ['1', 'DATE_TIME_NOT_SET', 'Date/time not set'],
    ['2', 'NEW_INK_CORE_DIFFERENT_REFERENCE', 'New ink core has a different ink reference'],
    ['4', 'EHT_CALIBRATION_REQUIRED', 'EHT calibration required'],
    ['8', 'RESERVED_FAULT', 'Not assigned / reserved']
  ]
];

function decodeNibble(value, position) {
  const numeric = Number.parseInt(value, 16);
  return FAULT_MAP[position - 1]
    .filter(([bit]) => numeric & Number.parseInt(bit, 16))
    .map(([bit, code, label]) => ({ position, bit: Number.parseInt(bit, 16), code, label }));
}

function alarmLabel(alarm) {
  const labels = [];
  if (alarm.green) labels.push('Green');
  if (alarm.amber) labels.push('Amber');
  if (alarm.red) labels.push('Red');
  if (alarm.reserved) labels.push('Reserved');
  return labels.length ? labels.join(' + ') : 'None';
}

function decodeStatus(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!/^[0-9A-F]{7}$/.test(raw)) {
    return {
      raw,
      valid: false,
      error: 'WSI status must be exactly seven hexadecimal characters.'
    };
  }

  const faultMask = raw.slice(0, 6);
  const alarmMask = raw.slice(6);
  const faults = [...faultMask].flatMap((nibble, index) => decodeNibble(nibble, index + 1));
  const alarmValue = Number.parseInt(alarmMask, 16);
  const alarm = {
    value: alarmValue,
    green: Boolean(alarmValue & 1),
    amber: Boolean(alarmValue & 2),
    red: Boolean(alarmValue & 4),
    reserved: Boolean(alarmValue & 8)
  };

  return {
    raw,
    valid: true,
    faultMask,
    alarmMask,
    faults,
    alarm: { ...alarm, label: alarmLabel(alarm) },
    hasFaults: faults.length > 0
  };
}

export { decodeStatus };

const STALE_AFTER_MS = 45000;
const TRAFFIC_LIGHTS = ['green', 'amber', 'blue', 'red'];

function isVisibleBusy(status) {
  return Boolean(status?.busy) && status.currentOperation !== 'poll';
}

function statusTimestamp(status) {
  return status?.lastSuccessfulAt || status?.checkedAt || status?.lastAttemptAt || null;
}

function isStale(status) {
  const timestamp = statusTimestamp(status);
  if (!timestamp) return status?.stale === true;

  const checkedAt = new Date(timestamp).valueOf();
  const timestampIsStale = Number.isFinite(checkedAt) && Date.now() - checkedAt > STALE_AFTER_MS;
  return status?.stale === true || timestampIsStale;
}

function formatAge(value) {
  if (!value) return 'No update yet';

  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return 'Unknown age';

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}

function activeFaults(decodedStatus) {
  if (!decodedStatus?.valid) return [];
  return decodedStatus.activeFaults || decodedStatus.faults || [];
}

function faultSummary(decodedStatus) {
  if (!decodedStatus?.valid) return decodedStatus?.error || 'Status not decoded';

  const faults = activeFaults(decodedStatus);
  if (faults.length) return faults.map((fault) => fault.label).join(', ');

  return 'No active faults';
}

function faultCountLabel(decodedStatus) {
  const count = activeFaults(decodedStatus).length;
  return count ? String(count) : 'None';
}

function compactFaultLines(decodedStatus, max = 3) {
  const faults = activeFaults(decodedStatus);
  if (!faults.length) return [];
  const visible = faults.slice(0, max).map((fault) => fault.label);
  if (faults.length > max) visible.push(`+${faults.length - max} more`);
  return visible;
}

function alarmSummary(decodedStatus) {
  if (!decodedStatus?.valid) return 'Unknown';
  return decodedStatus.alarm?.label || 'No alarm';
}

function printerState(decodedStatus) {
  if (!decodedStatus?.valid) {
    return {
      key: 'unknown',
      label: decodedStatus?.error || 'Unknown'
    };
  }
  const primary = decodedStatus.alarm?.primary;
  if (TRAFFIC_LIGHTS.includes(primary)) {
    return {
      key: primary,
      label: decodedStatus.alarm.label
    };
  }
  if (primary === 'yellow') {
    return {
      key: 'amber',
      label: decodedStatus.alarm.label
    };
  }
  return {
    key: 'none',
    label: decodedStatus.alarm?.label || 'None'
  };
}

function trafficLightMarkup(decodedStatus, { stale = false } = {}) {
  const state = printerState(decodedStatus);
  const nodes = TRAFFIC_LIGHTS.map((light) => {
    const active = state.key === light;
    const label = `${light[0].toUpperCase()}${light.slice(1)} ${active ? 'active' : 'inactive'}`;
    const span = document.createElement('span');
    span.className = `traffic-light traffic-${light}${active ? ' active' : ''}`;
    span.setAttribute('aria-label', label);
    span.setAttribute('title', label);
    span.appendChild(document.createElement('span'));
    return span;
  });

  const wrapper = document.createElement('div');
  wrapper.className = `traffic-light-group state-${state.key}${stale ? ' is-stale' : ''}`;
  wrapper.setAttribute('role', 'img');
  wrapper.setAttribute('aria-label', `Printer state ${state.label}${stale ? ', last known state' : ''}`);
  for (const node of nodes) wrapper.appendChild(node);
  return wrapper;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return `${hours}h ${min}m`;
}

function statusTone(coderOrStatus) {
  const config = coderOrStatus?.config;
  if (config && !config.enabled) return 'disabled';
  if (coderOrStatus?.state === 'disabled') return 'disabled';
  if (coderOrStatus?.ok === false || coderOrStatus?.online === false || coderOrStatus?.state === 'offline') return 'offline';
  if (isStale(coderOrStatus)) return 'warning';
  if (coderOrStatus?.online || coderOrStatus?.state === 'online') return 'online';
  return 'unknown';
}

function statusLabel(coderOrStatus) {
  const config = coderOrStatus?.config;
  if (config && !config.enabled) return 'Disabled';
  if (coderOrStatus?.state === 'disabled') return 'Disabled';

  if (isVisibleBusy(coderOrStatus)) {
    return coderOrStatus.currentOperation
      ? `Busy: ${coderOrStatus.currentOperation}`
      : 'Busy';
  }

  const stale = isStale(coderOrStatus);
  if (coderOrStatus?.ok === false || coderOrStatus?.online === false || coderOrStatus?.state === 'offline') {
    return stale ? 'Offline — last known status' : 'Offline';
  }

  if (coderOrStatus?.online || coderOrStatus?.state === 'online') {
    return stale ? 'Online — last known status' : 'Online';
  }

  return stale ? 'Last known status' : 'Not checked';
}

function setLiveBadge(badge, connected) {
  if (!badge) return;

  badge.className = connected ? 'live-indicator connected' : 'live-indicator disconnected';

  const label = badge.querySelector('span:last-child');
  if (label) label.textContent = connected ? 'LIVE' : 'LIVE DATA LOST';
}

export {
  STALE_AFTER_MS,
  activeFaults,
  alarmSummary,
  compactFaultLines,
  faultCountLabel,
  faultSummary,
  formatDuration,
  formatAge,
  isStale,
  isVisibleBusy,
  printerState,
  setLiveBadge,
  statusLabel,
  statusTimestamp,
  statusTone,
  trafficLightMarkup
};

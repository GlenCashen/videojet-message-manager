const STALE_AFTER_MS = 45000;

function isVisibleBusy(status) {
  return Boolean(status?.busy) && status.currentOperation !== 'poll';
}

function statusTimestamp(status) {
  return status?.lastSuccessfulAt || status?.checkedAt || status?.lastAttemptAt || null;
}

function isStale(status) {
  if (typeof status?.stale === 'boolean') return status.stale;

  const timestamp = statusTimestamp(status);
  if (!timestamp) return false;

  const checkedAt = new Date(timestamp).valueOf();
  return Number.isFinite(checkedAt) && Date.now() - checkedAt > STALE_AFTER_MS;
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

function faultSummary(decodedStatus) {
  if (!decodedStatus?.valid) return decodedStatus?.error || 'Status not decoded';

  const faults = decodedStatus.faults || [];
  if (faults.length) return faults.map((fault) => fault.label).join(', ');

  return 'No active faults';
}

function alarmSummary(decodedStatus) {
  if (!decodedStatus?.valid) return 'Unknown';
  return decodedStatus.alarm?.label || 'No alarm';
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
    return stale ? 'Offline, stale data' : 'Offline';
  }

  if (coderOrStatus?.online || coderOrStatus?.state === 'online') {
    return stale ? 'Online, stale data' : 'Online';
  }

  return stale ? 'Data stale' : 'Not checked';
}

function setLiveBadge(badge, connected) {
  if (!badge) return;

  badge.className = connected ? 'live-indicator connected' : 'live-indicator disconnected';

  const label = badge.querySelector('span:last-child');
  if (label) label.textContent = connected ? 'LIVE' : 'LIVE DATA LOST';
}

export {
  STALE_AFTER_MS,
  alarmSummary,
  faultSummary,
  formatAge,
  isStale,
  isVisibleBusy,
  setLiveBadge,
  statusLabel,
  statusTimestamp,
  statusTone
};

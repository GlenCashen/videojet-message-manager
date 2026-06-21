import { subscribeToPrinterEvents } from './js/events.js';
import { normalizeError, setNotice } from './js/dom.js';
import { renderNavigation } from './js/navigation.js';
import { applyReleasePresence, loadReleaseWorkflow, setupReleaseWorkflow } from './js/release-workflow.js';
import { hasCapability, loadSession } from './js/session.js';
import { setLiveBadge } from './js/status-ui.js';

const notice = document.getElementById('releaseWorkflowNotice');
let syncTimer = null;
let syncing = false;
let initialized = false;

async function syncReleases({ quiet = true } = {}) {
  if (syncing || document.hidden || document.querySelector('dialog[open]')) return;
  syncing = true;
  try {
    await loadReleaseWorkflow({ preserveForms: initialized });
    initialized = true;
    if (!quiet) setNotice(notice, 'Production register is up to date.', 'success');
  } catch (error) {
    setNotice(notice, `Automatic sync failed: ${normalizeError(error)}`, 'error');
  } finally {
    syncing = false;
  }
}

function scheduleSync() {
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => syncReleases(), 150);
}

async function start() {
  await loadSession();
  renderNavigation(document.getElementById('topNavigation'), { active: '/production-releases' });
  if (!hasCapability('viewBatchReleases')) {
    setNotice(notice, 'You do not have permission to view production releases.', 'error');
    return;
  }
  setupReleaseWorkflow();
  subscribeToPrinterEvents({
    onConnected: () => setLiveBadge(document.getElementById('serverConnectionBadge'), true),
    onHeartbeat: () => setLiveBadge(document.getElementById('serverConnectionBadge'), true),
    onDisconnected: () => setLiveBadge(document.getElementById('serverConnectionBadge'), false),
    onBatchReleasePresence: (payload) => { applyReleasePresence(payload); scheduleSync(); },
    onBatchReleaseChanged: scheduleSync,
    onBatchReleaseExecution: scheduleSync
  });
  await syncReleases();
  window.setInterval(() => syncReleases(), 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncReleases(); });
}

start().catch((error) => setNotice(notice, normalizeError(error), 'error'));

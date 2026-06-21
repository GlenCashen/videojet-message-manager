import { applyFleetSnapshot, applyPrinterConfig, applyPrinterEvent, applyStatusSnapshot, loadPrinters, loadStatuses, renderDashboard, setupDashboard } from './js/dashboard.js';
import { setupEditor, startEdit } from './js/editor.js';
import { subscribeToPrinterEvents } from './js/events.js';
import { applyLogEntry, loadLogs, renderLogs, setupLogs } from './js/logs.js';
import { loadMessageConfig, setupMessageConfig } from './js/message-config.js';
import { renderNavigation } from './js/navigation.js';
import { hasCapability, loadSession } from './js/session.js';
import { applyEmulatorState, loadConfig, setupSinglePrinterTools } from './js/single-printer-tools.js';
import { state } from './js/state.js';
import { setLiveBadge } from './js/status-ui.js';
import { clear, el, normalizeError, setNotice } from './js/dom.js';
import { elements } from './js/elements.js';
import { loadUsers, setupUserManagement } from './js/user-management.js';

function canLoadLogs() {
  return hasCapability('viewAudit') || hasCapability('accessDiagnostics');
}

function applyCapabilityLayout() {
  elements.editorPanel.classList.toggle('hidden', true);
  elements.messageConfigPanel?.classList.toggle('hidden', !hasCapability('editMessages'));
  elements.faultHistoryPanel?.classList.toggle('hidden', !hasCapability('viewFaultHistory'));
  elements.devPanel?.classList.toggle('hidden', !hasCapability('accessDiagnostics'));
  elements.logPanel?.classList.toggle('hidden', !canLoadLogs());
  elements.userPanel?.classList.toggle('hidden', !hasCapability('manageUsers'));
}

function editorSections() {
  return [
    { id: 'overview', label: 'Overview', href: '/editor', visible: true, panel: null },
    { id: 'printers', label: 'Printers', href: '/editor#printers', visible: true, panel: document.querySelector('.dashboard-panel') },
    { id: 'messages', label: 'Messages', href: '/editor#messages', visible: hasCapability('editMessages'), panel: elements.messageConfigPanel },
    { id: 'users', label: 'Users', href: '/editor/users', visible: hasCapability('manageUsers'), panel: elements.userPanel },
    { id: 'faults', label: 'Fault history', href: '/editor/faults', visible: hasCapability('viewFaultHistory'), panel: elements.faultHistoryPanel },
    { id: 'audit', label: 'Audit', href: '/editor#audit', visible: canLoadLogs(), panel: elements.logPanel },
    { id: 'diagnostics', label: 'Diagnostics', href: '/editor#diagnostics', visible: hasCapability('accessDiagnostics'), panel: elements.devPanel }
  ].filter((section) => section.visible);
}

function currentEditorSection() {
  const pathPart = window.location.pathname.split('/')[2];
  if (pathPart === 'users') return 'users';
  if (pathPart === 'faults') return 'faults';
  const hash = window.location.hash.replace('#', '');
  if (hash) return hash;
  return 'overview';
}

function setDetailsOpen(panel, open) {
  const details = panel?.querySelector('details');
  if (details) details.open = open;
}

function ensureEditorSubnav() {
  if (!elements.editorSubnav) {
    elements.editorSubnav = el('nav', {
      id: 'editorSubnav',
      className: 'sub-nav',
      'aria-label': 'Editor sections'
    });
  }

  if (!elements.topNavigation) return;
  const mainNav = elements.topNavigation.querySelector('.top-nav');
  if (mainNav) mainNav.insertAdjacentElement('afterend', elements.editorSubnav);
  else elements.topNavigation.appendChild(elements.editorSubnav);
}

function renderEditorSubnav() {
  if (!elements.editorSubnav) return;
  const activeSection = currentEditorSection();
  clear(elements.editorSubnav);
  const sections = editorSections();
  for (const section of sections) {
    elements.editorSubnav.appendChild(el('a', {
      href: section.href,
      className: section.id === activeSection ? 'sub-nav-link active' : 'sub-nav-link',
      text: section.label
    }));
  }
  const active = sections.find((section) => section.id === activeSection) || sections[0];
  if (elements.editorBreadcrumb) elements.editorBreadcrumb.textContent = `Editor / ${active.label}`;
}

function applyEditorSectionContext({ scroll = false } = {}) {
  const activeSection = currentEditorSection();
  const sections = editorSections();
  const dashboardPanel = document.querySelector('.dashboard-panel');
  const activePanel = activeSection === 'overview'
    ? dashboardPanel
    : sections.find((section) => section.id === activeSection)?.panel || dashboardPanel;
  const panels = new Set(sections.map((section) => section.panel).filter(Boolean));
  panels.add(dashboardPanel);
  for (const panel of panels) {
    panel.classList.toggle('section-inactive', panel !== activePanel);
    setDetailsOpen(panel, panel === activePanel);
  }
  renderEditorSubnav();
  const active = sections.find((section) => section.id === activeSection) || sections[0];
  const heading = document.querySelector('.app-header h1');
  if (heading) heading.textContent = active.label;
  if (scroll && activePanel) activePanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function safeLoadLogs() {
  return canLoadLogs() ? loadLogs() : Promise.resolve();
}

function safeStartEdit(id) {
  if (hasCapability('configurePrinters')) startEdit(id);
}

function setupEventStream() {
  subscribeToPrinterEvents({
    onConnected: markServerConnected,
    onHeartbeat: markServerConnected,
    onDisconnected: markServerDisconnected,

    onPrinterStatus: (payload) => {
      markServerConnected();
      applyPrinterEvent(payload);
    },

    onPrinterConfig: (payload) => {
      markServerConnected();
      applyPrinterConfig(payload);
    },

    onFaultActivated: () => {
      markServerConnected();
    },

    onFaultCleared: () => {
      markServerConnected();
    },

    onStatusSnapshot: (payload) => {
      markServerConnected();
      applyStatusSnapshot(payload);
    },

    onFleetSnapshot: (payload) => {
      markServerConnected();
      applyFleetSnapshot(payload);
    },

    onLogsSnapshot: (payload) => {
      markServerConnected();
      if (canLoadLogs()) renderLogs(payload);
    },

    onLogEntry: (payload) => {
      markServerConnected();
      if (canLoadLogs()) applyLogEntry(payload);
    },


    onEmulatorSnapshot: (payload) => {
      markServerConnected();
      if (hasCapability('accessDiagnostics')) applyEmulatorState(payload);
    }
  });
}

function markServerConnected() {
  const wasConnected = state.serverConnected;
  state.lastServerEventAt = Date.now();
  state.serverConnected = true;

  document.body.classList.remove('server-disconnected');
  document.body.classList.add('server-connected');

  setLiveBadge(document.getElementById('serverConnectionBadge'), true);
  if (!wasConnected) renderDashboard();
}

function markServerDisconnected() {
  if (!state.serverConnected) return;
  state.serverConnected = false;

  document.body.classList.remove('server-connected');
  document.body.classList.add('server-disconnected');

  setLiveBadge(document.getElementById('serverConnectionBadge'), false);
  renderDashboard();
}
setInterval(() => {
  const age = Date.now() - state.lastServerEventAt;

  if (age > 45000) {
    markServerDisconnected();
  }
}, 5000);

async function start() {
  try {
    await loadSession();
    renderNavigation(elements.topNavigation, { active: '/editor' });
    ensureEditorSubnav();

    if (!hasCapability('viewEditor')) {
      setNotice(elements.dashboardMessage, 'You do not have permission to view the editor.', 'error');
      return;
    }

    applyCapabilityLayout();
    renderEditorSubnav();
    elements.editorSubnav?.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="/editor#"]');
      if (!link) return;
      window.setTimeout(() => applyEditorSectionContext({ scroll: true }), 0);
    });
    window.addEventListener('hashchange', () => applyEditorSectionContext({ scroll: true }));
    setupDashboard({ loadLogs: safeLoadLogs, startEdit: safeStartEdit });
    if (hasCapability('configurePrinters')) setupEditor({ loadPrinters });
    if (canLoadLogs()) setupLogs();
    if (hasCapability('editMessages')) setupMessageConfig();
    if (hasCapability('accessDiagnostics')) setupSinglePrinterTools({ loadLogs: safeLoadLogs });
    if (hasCapability('manageUsers')) setupUserManagement();
    setupEventStream();

    await Promise.all([
      hasCapability('accessDiagnostics') ? loadConfig() : Promise.resolve(),
      loadPrinters().then(loadStatuses),
      safeLoadLogs(),
      hasCapability('editMessages') ? loadMessageConfig() : Promise.resolve(),
      hasCapability('manageUsers') ? loadUsers() : Promise.resolve()
    ]);
    applyEditorSectionContext({ scroll: currentEditorSection() !== 'overview' });
  } catch (error) {
    setNotice(elements.dashboardMessage, normalizeError(error), 'error');
  }
}

start();

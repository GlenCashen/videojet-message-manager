const ROLES = new Set(['viewer', 'operator', 'planner', 'packaging_leader', 'qa', 'engineering', 'admin']);

function normalizeRole(role) {
  return ROLES.has(role) ? role : null;
}

function hasRole(user, role) {
  return Boolean(user?.roles?.includes(role));
}

function hasDevelopmentPrinterWildcard(user) {
  return Boolean(user?.developmentIdentity && user?.printerIds?.includes('*'));
}

function getCapabilities(user) {
  const viewer = hasRole(user, 'viewer');
  const operator = hasRole(user, 'operator');
  const planner = hasRole(user, 'planner');
  const packagingLeader = hasRole(user, 'packaging_leader');
  const qa = hasRole(user, 'qa');
  const engineering = hasRole(user, 'engineering');
  const admin = hasRole(user, 'admin');
  const privileged = planner || packagingLeader || qa || engineering || admin;

  return {
    viewDashboard: Boolean(user),
    viewEditor: privileged,
    viewAllPrinters: viewer || privileged || hasDevelopmentPrinterWildcard(user),
    operateAllPrinters: qa || engineering || admin || hasDevelopmentPrinterWildcard(user),
    editMessages: qa || engineering || admin,
    viewBatchReleases: operator || planner || packagingLeader || qa || engineering || admin,
    createBatchReleases: planner || packagingLeader || qa || engineering || admin,
    reviewBatchReleases: packagingLeader || qa || admin,
    manageProductMasters: qa || admin,
    configurePrinters: engineering || admin,
    manageUsers: admin,
    accessDiagnostics: engineering || admin,
    viewFaultHistory: Boolean(user),
    viewAudit: qa || engineering || admin
  };
}

function canViewDashboard(user) {
  return getCapabilities(user).viewDashboard;
}

function canViewEditor(user) {
  return getCapabilities(user).viewEditor;
}

function canViewPrinter(user, printerId) {
  if (!user) return false;
  const capabilities = getCapabilities(user);
  if (capabilities.viewAllPrinters) return true;
  if (hasRole(user, 'operator')) return user.printerIds.includes(printerId);
  return false;
}

function canOperatePrinter(user, printerId) {
  if (!user) return false;
  const capabilities = getCapabilities(user);
  if (capabilities.operateAllPrinters) return true;
  if (hasRole(user, 'operator')) return user.printerIds.includes(printerId);
  return false;
}

function canEditMessages(user) {
  return getCapabilities(user).editMessages;
}

function canConfigurePrinters(user) {
  return getCapabilities(user).configurePrinters;
}

function canViewFaultHistory(user) {
  return getCapabilities(user).viewFaultHistory;
}

function canViewAudit(user) {
  return getCapabilities(user).viewAudit;
}

function canManageUsers(user) {
  return getCapabilities(user).manageUsers;
}

function canAccessDiagnostics(user) {
  return getCapabilities(user).accessDiagnostics;
}

function visiblePrinters(user, printers) {
  return printers.filter((printer) => canViewPrinter(user, printer.id));
}

function developmentUser({ role = 'viewer', printerIds = [] } = {}) {
  const normalized = normalizeRole(role);
  if (!normalized) return null;
  const displayRole = normalized[0].toUpperCase() + normalized.slice(1);
  return {
    id: 'dev-user',
    username: `dev-${normalized}`,
    displayName: `Development ${displayRole}`,
    roles: [normalized],
    printerIds,
    developmentIdentity: true
  };
}

export {
  canAccessDiagnostics,
  canConfigurePrinters,
  canEditMessages,
  canManageUsers,
  canOperatePrinter,
  canViewAudit,
  canViewDashboard,
  canViewEditor,
  canViewFaultHistory,
  canViewPrinter,
  developmentUser,
  getCapabilities,
  normalizeRole,
  visiblePrinters
};

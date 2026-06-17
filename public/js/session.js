import { apiJson } from './api.js';

let sessionPromise = null;
let session = null;

async function loadSession({ force = false } = {}) {
  if (!sessionPromise || force) {
    sessionPromise = apiJson('/api/session').then((value) => {
      session = value;
      return value;
    });
  }
  return sessionPromise;
}

async function getSession() {
  return session || loadSession();
}

function currentSession() {
  return session;
}

function hasCapability(name) {
  return Boolean(session?.capabilities?.[name]);
}

function canViewPrinter(printerId) {
  if (hasCapability('viewAllPrinters')) return true;
  return Boolean(session?.user?.printerIds?.includes(printerId));
}

function canOperatePrinter(printerId) {
  if (hasCapability('operateAllPrinters')) return true;
  return Boolean(session?.user?.roles?.includes('operator') && session.user.printerIds?.includes(printerId));
}

async function switchDevelopmentRole(role, printerIds = []) {
  const response = await apiJson('/api/dev/session', {
    method: 'POST',
    body: { role, printerIds }
  });
  sessionPromise = null;
  session = null;
  return response;
}

export {
  canOperatePrinter,
  canViewPrinter,
  currentSession,
  getSession,
  hasCapability,
  loadSession,
  switchDevelopmentRole
};

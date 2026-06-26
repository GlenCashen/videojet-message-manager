function appUrl(baseUrl, path) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  if (!root) return path;
  return `${root}${path.startsWith('/') ? path : `/${path}`}`;
}

function formatDateTime(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}

function valueOrDash(value) {
  const text = String(value || '').trim();
  return text || '-';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function printerName(payload) {
  return payload.printer?.name || payload.printerName || payload.printerId || 'Unknown printer';
}

function printerUrl(baseUrl, payload) {
  const id = payload.printer?.id || payload.printerId;
  return id ? appUrl(baseUrl, `/printers/${encodeURIComponent(id)}`) : appUrl(baseUrl, '/dashboard');
}

export { appUrl, escapeHtml, formatDateTime, printerName, printerUrl, valueOrDash };

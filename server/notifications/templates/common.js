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

function notificationHtml({ title, intro, rows = [], actionUrl, actionLabel = 'Open', tone = 'standard' }) {
  const accent = tone === 'danger' ? '#b42318' : tone === 'warning' ? '#b54708' : '#155eef';
  const rowHtml = rows.map(({ label, value }) => `
          <tr>
            <th style="color:#667085;font-size:13px;font-weight:700;padding:8px 16px 8px 0;text-align:left;vertical-align:top;width:180px;">${escapeHtml(label)}</th>
            <td style="color:#101828;font-size:15px;font-weight:700;padding:8px 0;vertical-align:top;">${escapeHtml(valueOrDash(value))}</td>
          </tr>`).join('');
  const action = actionUrl ? `
        <p style="margin:24px 0 0;">
          <a href="${escapeHtml(actionUrl)}" style="background:${accent};border-radius:8px;color:#ffffff;display:inline-block;font-size:15px;font-weight:800;padding:12px 18px;text-decoration:none;">${escapeHtml(actionLabel)}</a>
        </p>` : '';

  return `<!doctype html>
<html>
  <body style="background:#f3f6fa;margin:0;padding:24px;">
    <main style="background:#ffffff;border:1px solid #dbe4ef;border-radius:14px;font-family:Arial,sans-serif;margin:0 auto;max-width:680px;padding:28px;">
      <h1 style="color:#101828;font-size:24px;line-height:1.25;margin:0 0 12px;">${escapeHtml(title)}</h1>
      <p style="color:#344054;font-size:16px;line-height:1.45;margin:0 0 20px;">${escapeHtml(intro)}</p>
      <table role="presentation" style="border-collapse:collapse;width:100%;">
        <tbody>${rowHtml}
        </tbody>
      </table>${action}
    </main>
  </body>
</html>`;
}

function printerName(payload) {
  return payload.printer?.name || payload.printerName || payload.printerId || 'Unknown printer';
}

function printerUrl(baseUrl, payload) {
  const id = payload.printer?.id || payload.printerId;
  return id ? appUrl(baseUrl, `/printers/${encodeURIComponent(id)}`) : appUrl(baseUrl, '/dashboard');
}

export { appUrl, escapeHtml, formatDateTime, notificationHtml, printerName, printerUrl, valueOrDash };

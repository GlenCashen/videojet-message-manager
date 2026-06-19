import { normalizeError } from './dom.js';

async function apiJson(url, options = {}) {
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs ?? (method === 'GET' ? 10000 : 30000);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds: ${url}`);
    throw new Error(`Server unavailable: ${normalizeError(error)}`);
  } finally {
    window.clearTimeout(timeout);
  }

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw new Error('Server returned a malformed API response.');
  }

  if (!response.ok) {
    const error = new Error(data && data.error ? data.error : `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    if (response.status === 401 && !url.startsWith('/api/session') && !url.startsWith('/api/auth/')) {
      const returnTo = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
      window.location.href = `/login?returnTo=${returnTo}`;
    }
    throw error;
  }
  return data;
}

async function postJson(url, body) {
  return apiJson(url, { method: 'POST', body });
}

export { apiJson, postJson };

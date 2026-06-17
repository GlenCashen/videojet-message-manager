import { normalizeError } from './dom.js';

async function apiJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw new Error(`Server unavailable: ${normalizeError(error)}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw new Error('Server returned a malformed API response.');
  }

  if (!response.ok) {
    throw new Error(data && data.error ? data.error : `Request failed (${response.status})`);
  }
  return data;
}

async function postJson(url, body) {
  return apiJson(url, { method: 'POST', body });
}

export { apiJson, postJson };

import { normalizeError, setNotice } from './dom.js';

const message = document.getElementById('authMessage');

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`Server unavailable: ${normalizeError(error)}`);
  }

  const data = await response.json().catch(() => ({ ok: false, error: 'Server returned a malformed API response.' }));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function returnTo() {
  const value = new URLSearchParams(window.location.search).get('returnTo') || '/dashboard';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/api/')) return '/dashboard';
  return value;
}

function setupLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setNotice(message, 'Signing in...');
    const button = document.getElementById('loginButton');
    button.disabled = true;
    try {
      const data = await postJson('/api/auth/login', {
        username: form.username.value,
        password: form.password.value,
        returnTo: returnTo()
      });
      window.location.href = data.redirectTo || '/dashboard';
    } catch (error) {
      setNotice(message, normalizeError(error), 'error');
    } finally {
      button.disabled = false;
    }
  });
}

function setupChangePassword() {
  const form = document.getElementById('changePasswordForm');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setNotice(message, 'Saving password...');
    const button = document.getElementById('changePasswordButton');
    button.disabled = true;
    try {
      const data = await postJson('/api/auth/change-password', {
        currentPassword: form.currentPassword.value,
        newPassword: form.newPassword.value
      });
      window.location.href = data.redirectTo || '/dashboard';
    } catch (error) {
      setNotice(message, normalizeError(error), 'error');
    } finally {
      button.disabled = false;
    }
  });
}

setupLogin();
setupChangePassword();

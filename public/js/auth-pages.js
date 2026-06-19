import { normalizeError, setNotice } from './dom.js';
import { apiJson } from './api.js';

const message = document.getElementById('authMessage');

async function postJson(url, body) {
  return apiJson(url, { method: 'POST', body });
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

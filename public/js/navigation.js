import { canViewPrinter, currentSession, hasCapability, switchDevelopmentRole } from './session.js';
import { el, setNotice } from './dom.js';
import { apiJson } from './api.js';

function navLink(href, label, activePath) {
  return el('a', {
    className: activePath === href ? 'nav-link active' : 'nav-link',
    href
  }, label);
}

function renderNavigation(container, { active = window.location.pathname } = {}) {
  if (!container) return;
  const session = currentSession();
  container.textContent = '';

  const links = [navLink('/dashboard', 'Dashboard', active)];
  if (session?.user?.roles?.includes('operator')) links.push(navLink('/dashboard#my-printers', 'My printers', active));
  if (hasCapability('viewEditor')) links.push(navLink('/editor', 'Editor', active));
  if (hasCapability('manageUsers')) links.push(navLink('/editor#users', 'Users', active));

  container.appendChild(el('nav', { className: 'top-nav', 'aria-label': 'Main navigation' }, links));

  const identity = session?.user
    ? `Logged in as ${session.user.displayName}`
    : 'No session';
  container.appendChild(el('span', { className: 'nav-identity', text: identity }));

  if (session?.developmentIdentityActive) container.appendChild(createDevSwitcher(session));
  else if (session?.authenticated) container.appendChild(createLogoutButton());
}

function accessSummary(session) {
  if (hasCapability('viewAllPrinters') || session.user?.printerIds?.includes('*')) return 'All printers';
  const ids = session.user?.printerIds || [];
  return ids.length ? ids.join(', ') : 'No printer assignments';
}

function createDevSwitcher(session) {
  const message = el('p', { className: 'notice hidden dev-switcher-message', 'aria-live': 'polite' });
  const roleSelect = el('select', { 'aria-label': 'Development role' });
  for (const role of ['viewer', 'operator', 'qa', 'engineering', 'admin']) {
    roleSelect.appendChild(el('option', {
      value: role,
      selected: session.user?.roles?.includes(role) ? 'selected' : null,
      text: role
    }));
  }

  const printersInput = el('input', {
    value: session.user?.printerIds?.join(',') || '',
    placeholder: 'coder-1,coder-3 or *',
    'aria-label': 'Development assigned printer IDs'
  });
  const button = el('button', { type: 'button', className: 'ghost bordered' }, 'Switch');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await switchDevelopmentRole(roleSelect.value, printersInput.value.split(',').map((value) => value.trim()).filter(Boolean));
      window.location.reload();
    } catch (error) {
      setNotice(message, error.message, 'error');
      button.disabled = false;
    }
  });

  const summary = el('summary', {}, [
    el('span', { className: 'dev-mode-label', text: 'DEV MODE' }),
    el('strong', { text: session.user?.displayName || 'Development identity' }),
    el('span', { className: 'muted', text: `Access: ${accessSummary(session)}` }),
    el('span', { className: 'dev-change-link', text: 'Change identity' })
  ]);

  return el('details', { className: 'dev-identity-banner' }, [
    summary,
    el('div', { className: 'dev-switcher' }, [
      roleSelect,
      printersInput,
      button
    ]),
    message
  ]);
}

function createLogoutButton() {
  const button = el('button', { type: 'button', className: 'ghost bordered' }, 'Logout');
  button.addEventListener('click', async () => {
    button.disabled = true;
    const result = await apiJson('/api/auth/logout', { method: 'POST', body: {} });
    window.location.href = result.redirectTo || '/login';
  });
  return button;
}

function printerHref(printerId) {
  return `/printers/${encodeURIComponent(printerId)}`;
}

export { canViewPrinter, printerHref, renderNavigation };

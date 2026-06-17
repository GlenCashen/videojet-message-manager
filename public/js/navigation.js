import { canViewPrinter, currentSession, hasCapability, switchDevelopmentRole } from './session.js';
import { el } from './dom.js';

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
    ? `${session.user.displayName} (${session.user.roles.join(', ')})`
    : 'No session';
  container.appendChild(el('span', { className: 'nav-identity', text: identity }));

  if (session?.devIdentityEnabled) container.appendChild(createDevSwitcher(session));
}

function createDevSwitcher(session) {
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
    placeholder: 'coder-1,coder-3',
    'aria-label': 'Development assigned printer IDs'
  });
  const button = el('button', { type: 'button', className: 'ghost bordered' }, 'Switch');
  button.addEventListener('click', async () => {
    await switchDevelopmentRole(roleSelect.value, printersInput.value.split(',').map((value) => value.trim()).filter(Boolean));
    window.location.reload();
  });

  return el('div', { className: 'dev-switcher' }, [
    roleSelect,
    printersInput,
    button
  ]);
}

function printerHref(printerId) {
  return `/printers/${encodeURIComponent(printerId)}`;
}

export { canViewPrinter, printerHref, renderNavigation };

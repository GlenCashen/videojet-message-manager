import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';
import { currentSession } from './session.js';

const ROLES = ['viewer', 'operator', 'planner', 'packaging_leader', 'qa', 'engineering', 'admin'];
let users = [];
let selectedId = null;

function selectedUser() {
  return users.find((user) => user.id === selectedId) || null;
}

function roleInputs() {
  return [...elements.userRoles.querySelectorAll('input[type="checkbox"]')];
}

function splitPrinterIds(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function renderRoleInputs() {
  clear(elements.userRoles);
  elements.userRoles.appendChild(el('legend', { text: 'Roles' }));
  for (const role of ROLES) {
    elements.userRoles.appendChild(el('label', { className: 'checkbox-line' }, [
      el('input', { type: 'checkbox', value: role }),
      el('span', { text: role })
    ]));
  }
}

function renderList() {
  clear(elements.userList);
  if (!users.length) {
    elements.userList.appendChild(el('p', { className: 'muted', text: 'No users configured.' }));
    return;
  }
  for (const user of users) {
    elements.userList.appendChild(el('button', {
      type: 'button',
      className: user.id === selectedId ? 'message-list-item active' : 'message-list-item',
      dataset: { id: user.id }
    }, [
      el('strong', { text: user.displayName }),
      el('span', { text: `${user.username} | ${user.enabled ? 'Enabled' : 'Disabled'} | ${user.roles.join(', ')}` })
    ]));
  }
}

function populateForm(user) {
  selectedId = user?.id || '';
  elements.userForm.classList.remove('hidden');
  elements.userId.value = user?.id || '';
  elements.userUsername.value = user?.username || '';
  elements.userUsername.disabled = Boolean(user?.id);
  elements.userDisplayName.value = user?.displayName || '';
  elements.userPassword.value = '';
  elements.userPassword.required = !user?.id;
  elements.userPrinterIds.value = user?.printerIds?.join(',') || '';
  elements.userEnabled.checked = user?.enabled ?? true;
  elements.userMustChangePassword.checked = user?.mustChangePassword ?? true;
  const session = currentSession();
  elements.simulateUserButton.disabled = !user?.id || !user.enabled || user.mustChangePassword || user.id === session?.user?.id;
  for (const input of roleInputs()) input.checked = user?.roles?.includes(input.value) || (!user && input.value === 'viewer');
  renderList();
}

async function simulateSelectedUser() {
  const user = selectedUser();
  if (!user) return;
  elements.simulateUserButton.disabled = true;
  setNotice(elements.userMessage, `Starting simulation for ${user.displayName}...`);
  try {
    const result = await apiJson('/api/admin/simulate-user', { method: 'POST', body: { userId: user.id } });
    window.location.href = result.redirectTo || '/dashboard';
  } catch (error) {
    setNotice(elements.userMessage, normalizeError(error), 'error');
    elements.simulateUserButton.disabled = false;
  }
}

function collectUser() {
  return {
    username: elements.userUsername.value.trim(),
    displayName: elements.userDisplayName.value.trim(),
    password: elements.userPassword.value || undefined,
    roles: roleInputs().filter((input) => input.checked).map((input) => input.value),
    printerIds: splitPrinterIds(elements.userPrinterIds.value),
    enabled: elements.userEnabled.checked,
    mustChangePassword: elements.userMustChangePassword.checked
  };
}

async function loadUsers() {
  setNotice(elements.userMessage, 'Loading users...');
  try {
    users = await apiJson('/api/users');
    renderList();
    if (selectedUser()) populateForm(selectedUser());
    else populateForm(users[0] || null);
    setNotice(elements.userMessage);
  } catch (error) {
    setNotice(elements.userMessage, normalizeError(error), 'error');
  }
}

async function saveUser(event) {
  event.preventDefault();
  elements.saveUserButton.disabled = true;
  setNotice(elements.userMessage, 'Saving user...');
  try {
    const body = collectUser();
    const existingId = elements.userId.value;
    const result = existingId
      ? await apiJson(`/api/users/${encodeURIComponent(existingId)}`, { method: 'PUT', body })
      : await apiJson('/api/users', { method: 'POST', body });
    await loadUsers();
    populateForm(result.user);
    setNotice(elements.userMessage, `${result.user.displayName} saved.`, 'success');
  } catch (error) {
    setNotice(elements.userMessage, normalizeError(error), 'error');
  } finally {
    elements.saveUserButton.disabled = false;
  }
}

function setupUserManagement() {
  renderRoleInputs();
  elements.userList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-id]');
    if (!button) return;
    const user = users.find((item) => item.id === button.dataset.id);
    if (user) populateForm(user);
  });
  elements.newUserButton.addEventListener('click', () => populateForm(null));
  elements.simulateUserButton.addEventListener('click', simulateSelectedUser);
  elements.userForm.addEventListener('submit', saveUser);
  elements.refreshUsersButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    loadUsers();
  });
}

export { loadUsers, setupUserManagement };

import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { elements } from './elements.js';

const ROLES = ['viewer', 'operator', 'planner', 'packaging_leader', 'qa', 'engineering', 'admin'];
const EVENTS = [
  ['release.pending_review', 'Release needs approval'],
  ['printer.message_mismatch', 'Printer message mismatch'],
  ['printer.offline', 'Printer offline'],
  ['printer.fault', 'Printer fault']
];

let lists = [];
let users = [];
let selectedId = null;

function selectedList() {
  return lists.find((list) => list.id === selectedId) || null;
}

function labelForEvent(eventKey) {
  return EVENTS.find(([key]) => key === eventKey)?.[1] || eventKey;
}

function checkboxValues(container) {
  return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function splitEmails(value) {
  return [...new Set(String(value || '').split(/[\n,;]/).map((item) => item.trim()).filter(Boolean))];
}

function renderEventOptions() {
  clear(elements.notificationEvent);
  for (const [value, label] of EVENTS) {
    elements.notificationEvent.appendChild(el('option', { value, text: label }));
  }
}

function renderRoleChoices(selected = []) {
  const active = new Set(selected);
  clear(elements.notificationRoles);
  elements.notificationRoles.appendChild(el('legend', { text: 'Role recipients' }));
  elements.notificationRoles.appendChild(el('p', { className: 'muted', text: 'Send to enabled users in these roles who have email addresses.' }));
  const grid = el('div', { className: 'notification-recipient-grid' });
  for (const role of ROLES) {
    grid.appendChild(el('label', { className: 'checkbox-line' }, [
      el('input', { type: 'checkbox', value: role, checked: active.has(role) ? 'checked' : null }),
      el('span', { text: role })
    ]));
  }
  elements.notificationRoles.appendChild(grid);
}

function renderUserChoices(selected = []) {
  const active = new Set(selected);
  clear(elements.notificationUsers);
  elements.notificationUsers.appendChild(el('legend', { text: 'Individual recipients' }));
  const emailableUsers = users.filter((user) => user.enabled && user.email);
  if (!emailableUsers.length) {
    elements.notificationUsers.appendChild(el('p', { className: 'muted', text: 'No enabled users have email addresses yet.' }));
    return;
  }
  const grid = el('div', { className: 'notification-recipient-grid' });
  for (const user of emailableUsers) {
    grid.appendChild(el('label', { className: 'checkbox-line notification-user-choice' }, [
      el('input', { type: 'checkbox', value: user.id, checked: active.has(user.id) ? 'checked' : null }),
      el('span', {}, [
        el('strong', { text: user.displayName }),
        el('small', { text: user.email })
      ])
    ]));
  }
  elements.notificationUsers.appendChild(grid);
}

function renderList() {
  clear(elements.notificationList);
  if (!lists.length) {
    elements.notificationList.appendChild(el('p', { className: 'muted', text: 'No email lists configured.' }));
    return;
  }
  for (const list of lists) {
    const recipientCount = (list.recipientRoles?.length || 0) + (list.recipientUserIds?.length || 0) + (list.recipientEmails?.length || 0);
    elements.notificationList.appendChild(el('button', {
      type: 'button',
      className: list.id === selectedId ? 'message-list-item active' : 'message-list-item',
      dataset: { id: list.id }
    }, [
      el('strong', { text: list.name }),
      el('span', { text: `${labelForEvent(list.eventKey)} | ${list.enabled ? 'Enabled' : 'Disabled'} | ${recipientCount} recipient rules` })
    ]));
  }
}

function populateForm(list) {
  selectedId = list?.id || '';
  elements.notificationForm.classList.remove('hidden');
  elements.notificationListId.value = list?.id || '';
  elements.notificationName.value = list?.name || '';
  elements.notificationEvent.value = list?.eventKey || EVENTS[0][0];
  elements.notificationDescription.value = list?.description || '';
  elements.notificationEnabled.checked = list?.enabled ?? true;
  elements.notificationEmails.value = (list?.recipientEmails || []).join('\n');
  elements.deleteNotificationListButton.disabled = !list?.id;
  renderRoleChoices(list?.recipientRoles || (list ? [] : ['packaging_leader', 'qa', 'admin']));
  renderUserChoices(list?.recipientUserIds || []);
  renderList();
}

function collectList() {
  return {
    name: elements.notificationName.value.trim(),
    eventKey: elements.notificationEvent.value,
    description: elements.notificationDescription.value.trim(),
    enabled: elements.notificationEnabled.checked,
    recipientRoles: checkboxValues(elements.notificationRoles),
    recipientUserIds: checkboxValues(elements.notificationUsers),
    recipientEmails: splitEmails(elements.notificationEmails.value)
  };
}

async function loadNotificationLists() {
  setNotice(elements.notificationMessage, 'Loading email lists...');
  try {
    [lists, users] = await Promise.all([
      apiJson('/api/notification-lists'),
      apiJson('/api/users')
    ]);
    renderEventOptions();
    renderList();
    if (selectedList()) populateForm(selectedList());
    else populateForm(lists[0] || null);
    setNotice(elements.notificationMessage);
  } catch (error) {
    setNotice(elements.notificationMessage, normalizeError(error), 'error');
  }
}

async function saveNotificationList(event) {
  event.preventDefault();
  elements.saveNotificationListButton.disabled = true;
  setNotice(elements.notificationMessage, 'Saving email list...');
  try {
    const existingId = elements.notificationListId.value;
    const result = existingId
      ? await apiJson(`/api/notification-lists/${encodeURIComponent(existingId)}`, { method: 'PUT', body: collectList() })
      : await apiJson('/api/notification-lists', { method: 'POST', body: collectList() });
    selectedId = result.list.id;
    await loadNotificationLists();
    populateForm(result.list);
    setNotice(elements.notificationMessage, `${result.list.name} saved.`, 'success');
  } catch (error) {
    setNotice(elements.notificationMessage, normalizeError(error), 'error');
  } finally {
    elements.saveNotificationListButton.disabled = false;
  }
}

async function deleteSelectedNotificationList() {
  const list = selectedList();
  if (!list) return;
  if (!window.confirm(`Delete email list "${list.name}"? Delivery history will remain in the audit database.`)) return;
  elements.deleteNotificationListButton.disabled = true;
  setNotice(elements.notificationMessage, 'Deleting email list...');
  try {
    await apiJson(`/api/notification-lists/${encodeURIComponent(list.id)}`, { method: 'DELETE' });
    selectedId = '';
    await loadNotificationLists();
    setNotice(elements.notificationMessage, `${list.name} deleted.`, 'success');
  } catch (error) {
    setNotice(elements.notificationMessage, normalizeError(error), 'error');
  } finally {
    elements.deleteNotificationListButton.disabled = !selectedList();
  }
}

function setupNotificationLists() {
  renderEventOptions();
  elements.notificationList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-id]');
    if (!button) return;
    const list = lists.find((item) => item.id === button.dataset.id);
    if (list) populateForm(list);
  });
  elements.newNotificationListButton.addEventListener('click', () => populateForm(null));
  elements.deleteNotificationListButton.addEventListener('click', deleteSelectedNotificationList);
  elements.notificationForm.addEventListener('submit', saveNotificationList);
  elements.refreshNotificationListsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    loadNotificationLists();
  });
}

export { loadNotificationLists, setupNotificationLists };

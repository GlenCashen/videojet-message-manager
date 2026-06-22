import { operatorNoticeText } from './operator-errors.js';

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function append(parent, ...children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(operatorNoticeText(child)) : child);
  }
  return parent;
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === undefined) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = operatorNoticeText(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  return append(node, children);
}

function setNotice(node, message = '', type = 'info') {
  const displayMessage = operatorNoticeText(message);
  node.textContent = displayMessage;
  node.className = `notice ${type}`;
  node.classList.toggle('hidden', !displayMessage);
}

function formatDate(value) {
  if (!value) return 'Not checked';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown' : date.toLocaleString();
}

function normalizeError(error) {
  if (error instanceof Error) return operatorNoticeText(error.message);
  return operatorNoticeText(String(error || 'Unknown error'));
}

export { clear, el, formatDate, normalizeError, setNotice };

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRole } from './permissions.js';
import {
  getUserById,
  getUserByUsername,
  listUserRecords,
  recordLogin,
  replaceUserRecords,
  setPasswordHash,
  upsertUserRecord
} from './repositories/user-repository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_USERS_PATH = path.join(__dirname, '..', 'data', 'users.json');
const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;

function usersPath(filePath) {
  return filePath || process.env.USERS_PATH || DEFAULT_USERS_PATH;
}

function useJsonFile(filePath) {
  return Boolean(filePath);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key.toString('base64url')));
  });
  return `scrypt:${salt}:${hash}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash.startsWith('scrypt:')) return false;
  const [, salt, expected] = storedHash.split(':');
  if (!salt || !expected) return false;
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password || '', salt, 64, (error, key) => error ? reject(error) : resolve(key.toString('base64url')));
  });
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

function publicUser(user) {
  if (!user) return null;
  const {
    passwordHash: _passwordHash,
    ...safeUser
  } = user;
  return clone(safeUser);
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_PATTERN.test(value)) {
    throw new Error('Username must be 3-40 characters and use letters, numbers, dots, hyphens or underscores.');
  }
  return value;
}

function validateRoles(roles) {
  if (!Array.isArray(roles) || !roles.length) throw new Error('At least one role is required.');
  const values = roles.map((role) => normalizeRole(String(role || '').trim()));
  if (values.some((role) => !role)) throw new Error('One or more roles are invalid.');
  const normalized = [...new Set(values)];
  return normalized;
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return null;
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) throw new Error('Email address must be valid.');
  return value;
}

function validatePrinterIds(printerIds = [], printers = []) {
  if (!Array.isArray(printerIds)) throw new Error('printerIds must be an array.');
  if (printerIds.includes('*')) throw new Error('Wildcard printer assignment is only available for development identity.');
  const known = new Set(printers.map((printer) => printer.id));
  const normalized = [...new Set(printerIds.map((id) => String(id || '').trim()).filter(Boolean))];
  for (const id of normalized) {
    if (!known.has(id)) {
      const error = new Error(`Unknown printer id: ${id}`);
      error.code = 'UNKNOWN_PRINTER';
      throw error;
    }
  }
  return normalized;
}

function normalizeUserRecord(input, printers, existing = {}) {
  const now = new Date().toISOString();
  const username = validateUsername(input.username ?? existing.username);
  const roles = validateRoles(input.roles ?? existing.roles);
  const printerIds = validatePrinterIds(input.printerIds ?? existing.printerIds ?? [], printers);
  const displayName = String(input.displayName ?? existing.displayName ?? username).trim();
  if (!displayName || displayName.length > 80) throw new Error('Display name must be 1-80 characters.');
  const email = normalizeEmail(input.email ?? existing.email);

  return {
    id: existing.id || crypto.randomUUID(),
    username,
    displayName,
    email,
    roles,
    printerIds,
    enabled: input.enabled ?? existing.enabled ?? true,
    mustChangePassword: input.mustChangePassword ?? existing.mustChangePassword ?? false,
    passwordHash: input.passwordHash ?? existing.passwordHash,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    lastLoginAt: existing.lastLoginAt || null
  };
}

async function readUsers(filePath) {
  if (!useJsonFile(filePath)) return listUserRecords();
  const target = usersPath(filePath);
  if (!(await fileExists(target))) return [];
  const raw = await fs.readFile(target, 'utf8');
  const users = JSON.parse(raw || '[]');
  if (!Array.isArray(users)) throw new Error('users.json must contain an array.');
  return users;
}

async function writeUsers(users, filePath) {
  if (!useJsonFile(filePath)) return replaceUserRecords(users);
  const target = usersPath(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.users-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
  return users;
}

function assertUniqueUsername(users, username, existingId = null) {
  const lower = username.toLowerCase();
  if (users.some((user) => user.id !== existingId && user.username.toLowerCase() === lower)) {
    throw new Error(`Username ${username} already exists.`);
  }
}

function assertLastEnabledAdmin(users, nextUsers) {
  const before = users.filter((user) => user.enabled && user.roles?.includes('admin')).length;
  const after = nextUsers.filter((user) => user.enabled && user.roles?.includes('admin')).length;
  if (before > 0 && after < 1) throw new Error('At least one enabled Admin user is required.');
}

async function createUser(input, { printers = [], filePath } = {}) {
  const users = await readUsers(filePath);
  if (!input.password) throw new Error('Temporary password is required for new users.');
  const user = normalizeUserRecord({
    ...input,
    passwordHash: await hashPassword(input.password),
    mustChangePassword: input.mustChangePassword ?? true
  }, printers);
  assertUniqueUsername(users, user.username);
  if (useJsonFile(filePath)) {
    const next = [...users, user];
    await writeUsers(next, filePath);
  } else {
    upsertUserRecord(user);
  }
  return publicUser(user);
}

async function updateUser(id, changes, { printers = [], filePath } = {}) {
  const users = await readUsers(filePath);
  const index = users.findIndex((user) => user.id === id);
  if (index < 0) {
    const error = new Error(`User ${id} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  const passwordHash = changes.password ? await hashPassword(changes.password) : users[index].passwordHash;
  const updated = normalizeUserRecord({ ...users[index], ...changes, passwordHash }, printers, users[index]);
  assertUniqueUsername(users, updated.username, id);
  const next = users.map((user, userIndex) => userIndex === index ? updated : user);
  assertLastEnabledAdmin(users, next);
  if (useJsonFile(filePath)) await writeUsers(next, filePath);
  else upsertUserRecord(updated);
  return publicUser(updated);
}

async function listUsers(options = {}) {
  return (await readUsers(options.filePath)).map(publicUser);
}

async function findUserById(id, options = {}) {
  if (!useJsonFile(options.filePath)) return publicUser(getUserById(id));
  return publicUser((await readUsers(options.filePath)).find((user) => user.id === id));
}

async function authenticateUser(username, password, options = {}) {
  if (!useJsonFile(options.filePath)) {
    const user = getUserByUsername(String(username || '').trim());
    if (!user || !user.enabled || !(await verifyPassword(password, user.passwordHash))) return null;
    return publicUser(recordLogin(user.id));
  }
  const users = await readUsers(options.filePath);
  const user = users.find((item) => item.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!user || !user.enabled || !(await verifyPassword(password, user.passwordHash))) return null;
  const updated = { ...user, lastLoginAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeUsers(users.map((item) => item.id === user.id ? updated : item), options.filePath);
  return publicUser(updated);
}

async function changePassword(userId, currentPassword, nextPassword, options = {}) {
  if (!useJsonFile(options.filePath)) {
    const user = getUserById(userId);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) return null;
    return publicUser(setPasswordHash(user.id, await hashPassword(nextPassword), false));
  }
  const users = await readUsers(options.filePath);
  const user = users.find((item) => item.id === userId);
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) return null;
  const updated = {
    ...user,
    passwordHash: await hashPassword(nextPassword),
    mustChangePassword: false,
    updatedAt: new Date().toISOString()
  };
  await writeUsers(users.map((item) => item.id === userId ? updated : item), options.filePath);
  return publicUser(updated);
}

async function ensureBootstrapAdmin({ printers = [], enableDevIdentity = false, filePath } = {}) {
  const users = await readUsers(filePath);
  if (users.length) return { created: false, users: users.map(publicUser) };

  const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    if (enableDevIdentity) return { created: false, users: [] };
    throw new Error('No users exist. Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD or enable development identity.');
  }

  const admin = normalizeUserRecord({
    username,
    displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME || username,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || null,
    roles: ['admin'],
    printerIds: printers.map((printer) => printer.id),
    enabled: true,
    mustChangePassword: true,
    passwordHash: await hashPassword(password)
  }, printers);
  await writeUsers([admin], filePath);
  return { created: true, users: [publicUser(admin)] };
}

export {
  authenticateUser,
  changePassword,
  createUser,
  ensureBootstrapAdmin,
  findUserById,
  hashPassword,
  listUsers,
  publicUser,
  readUsers,
  updateUser,
  validatePrinterIds,
  validateRoles,
  writeUsers
};

import { getDb } from '../db.js';

function rowToUser(row, db) {
  if (!row) return null;
  const roles = db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(row.id).map((item) => item.role);
  const printerIds = db.prepare('SELECT printer_id FROM user_printer_assignments WHERE user_id = ? ORDER BY printer_id').all(row.id)
    .map((item) => item.printer_id);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roles,
    printerIds,
    enabled: Boolean(row.enabled),
    mustChangePassword: Boolean(row.must_change_password),
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || null
  };
}

function getUserById(id, db = getDb()) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id), db);
}

function getUserByUsername(username, db = getDb()) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username), db);
}

function listUserRecords(db = getDb()) {
  return db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map((row) => rowToUser(row, db));
}

function replaceRoles(userId, roles, db = getDb()) {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)');
  for (const role of roles) insert.run(userId, role);
}

function replacePrinterAssignments(userId, printerIds, db = getDb()) {
  db.prepare('DELETE FROM user_printer_assignments WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_printer_assignments (user_id, printer_id, created_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const printerId of printerIds) insert.run(userId, printerId, now);
}

function upsertUserRecord(user, db = getDb()) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (
      id, username, display_name, password_hash, enabled, must_change_password, created_at, updated_at, last_login_at, disabled_at
    ) VALUES (@id, @username, @displayName, @passwordHash, @enabled, @mustChangePassword, @createdAt, @updatedAt, @lastLoginAt, @disabledAt)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      password_hash = excluded.password_hash,
      enabled = excluded.enabled,
      must_change_password = excluded.must_change_password,
      updated_at = excluded.updated_at,
      last_login_at = excluded.last_login_at,
      disabled_at = excluded.disabled_at
  `).run({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    passwordHash: user.passwordHash,
    enabled: user.enabled === false ? 0 : 1,
    mustChangePassword: user.mustChangePassword ? 1 : 0,
    createdAt: user.createdAt || now,
    updatedAt: user.updatedAt || now,
    lastLoginAt: user.lastLoginAt || null,
    disabledAt: user.enabled ? null : (user.disabledAt || now)
  });
  replaceRoles(user.id, user.roles || [], db);
  replacePrinterAssignments(user.id, user.printerIds || [], db);
  return getUserById(user.id, db);
}

function replaceUserRecords(users, db = getDb()) {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM user_printer_assignments').run();
    db.prepare('DELETE FROM user_roles').run();
    db.prepare('DELETE FROM users').run();
    for (const user of users) upsertUserRecord(user, db);
  });
  run();
  return listUserRecords(db);
}

function recordLogin(userId, db = getDb()) {
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, userId);
  return getUserById(userId, db);
}

function setPasswordHash(userId, passwordHash, mustChangePassword = false, db = getDb()) {
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, mustChangePassword ? 1 : 0, now, userId);
  return getUserById(userId, db);
}

export {
  getUserById,
  getUserByUsername,
  listUserRecords,
  recordLogin,
  replacePrinterAssignments,
  replaceRoles,
  replaceUserRecords,
  setPasswordHash,
  upsertUserRecord
};

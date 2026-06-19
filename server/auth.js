import crypto from 'node:crypto';
import { getDb } from './db.js';
import { getSetting, setSetting } from './repositories/settings-repository.js';
import { getUserById } from './repositories/user-repository.js';

const COOKIE_NAME = 'vmm_session';
const SIMULATION_COOKIE_NAME = 'vmm_simulated_user';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_SECRET_SETTING = 'session_cookie_secret';

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function getSessionSecret(secret) {
  if (secret) return secret;
  const existing = getSetting(SESSION_SECRET_SETTING);
  if (existing?.value) return existing.value;
  const generated = crypto.randomBytes(32).toString('hex');
  setSetting(SESSION_SECRET_SETTING, { value: generated });
  return generated;
}

function createSessionManager({ secret, secure = false } = {}) {
  const sessionSecret = getSessionSecret(secret);

  function create(user) {
    const id = base64Url(crypto.randomUUID());
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const now = new Date().toISOString();
    getDb().prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, user.id, new Date(expiresAt).toISOString(), now, now);
    return `${id}.${sign(id, sessionSecret)}`;
  }

  function read(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return null;
    const [id, signature] = cookieValue.split('.');
    if (!id || !signature || sign(id, sessionSecret) !== signature) return null;

    const db = getDb();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!session) return null;
    const user = getUserById(session.user_id, db);
    if (!user || !user.enabled) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    return user;
  }

  function destroy(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return;
    const [id] = cookieValue.split('.');
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  function cookie(value) {
    return serializeCookie(COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure
    });
  }

  function clearCookie() {
    return serializeCookie(COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 0,
      secure
    });
  }

  function simulationCookie(userId) {
    const value = `${base64Url(userId)}.${sign(`simulate:${userId}`, sessionSecret)}`;
    return serializeCookie(SIMULATION_COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure
    });
  }

  function readSimulation(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return null;
    const [encodedId, signature] = cookieValue.split('.');
    let userId;
    try {
      userId = Buffer.from(encodedId, 'base64url').toString('utf8');
    } catch (_error) {
      return null;
    }
    if (!userId || signature !== sign(`simulate:${userId}`, sessionSecret)) return null;
    const user = getUserById(userId);
    return user?.enabled ? user : null;
  }

  function clearSimulationCookie() {
    return serializeCookie(SIMULATION_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 0,
      secure
    });
  }

  return {
    cookie,
    clearCookie,
    clearSimulationCookie,
    create,
    destroy,
    read,
    readSimulation,
    simulationCookie,
    cookieName: COOKIE_NAME,
    simulationCookieName: SIMULATION_COOKIE_NAME
  };
}

export { COOKIE_NAME, SIMULATION_COOKIE_NAME, createSessionManager };

import crypto from 'node:crypto';

const COOKIE_NAME = 'vmm_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

function createSessionManager({ secret, secure = false } = {}) {
  const sessions = new Map();
  const sessionSecret = secret || crypto.randomBytes(32).toString('hex');

  function create(user) {
    const id = base64Url(crypto.randomUUID());
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(id, { user, expiresAt });
    return `${id}.${sign(id, sessionSecret)}`;
  }

  function read(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return null;
    const [id, signature] = cookieValue.split('.');
    if (!id || !signature || sign(id, sessionSecret) !== signature) return null;

    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return session.user;
  }

  function destroy(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return;
    const [id] = cookieValue.split('.');
    sessions.delete(id);
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

  return { cookie, clearCookie, create, destroy, read, cookieName: COOKIE_NAME };
}

export { COOKIE_NAME, createSessionManager };

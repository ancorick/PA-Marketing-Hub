// Staff authentication and role-based permissions (PRD 4.3, NFR-S1).
// In production this delegates to the Academy Core Engine's sign-in; the local
// password store below is the development adapter with the same interface.
import crypto from 'node:crypto';
import { one, run, now } from '../db.js';
import { sha256, HttpError } from './util.js';
import { audit } from './core.js';

export const ROLES = ['viewer', 'editor', 'manager', 'admin', 'leadership'];

// Capability matrix, exactly as in PRD 4.3.
export const PERMISSIONS = {
  'dashboard.view':        ['viewer', 'editor', 'manager', 'admin', 'leadership'],
  'contacts.view':         ['editor', 'manager', 'admin'],
  'contacts.edit':         ['editor', 'manager', 'admin'],
  'contacts.export':       ['manager', 'admin'],
  'segments.edit':         ['editor', 'manager', 'admin'],
  'newsletter.edit':       ['editor', 'manager', 'admin'],
  'send.approve':          ['manager', 'admin'],
  'costs.edit':            ['manager', 'admin'],
  'consent.manual':        ['manager', 'admin'],
  'killswitch':            ['manager', 'admin'],
  'integrations.manage':   ['admin'],
  'users.manage':          ['admin'],
  'campaigns.edit':        ['editor', 'manager', 'admin'],
  'events.edit':           ['editor', 'manager', 'admin'],
  'audit.view':            ['manager', 'admin'],
};
export const can = (user, perm) => !!user && (PERMISSIONS[perm] || []).includes(user.role);
export const permissionsFor = (role) => Object.keys(PERMISSIONS).filter((p) => PERMISSIONS[p].includes(role));
// Leadership sees aggregates only, with small-number suppression (ANL-14, NFR-P5).
export const isAggregateOnly = (user) => user?.role === 'leadership';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

const SESSION_DAYS = 7;
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)',
    sha256(token), userId, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString(), now());
  return token;
}
export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}
export function userFromToken(token) {
  if (!token) return null;
  const row = one(
    `SELECT u.id, u.email, u.name, u.role, u.ui_language, u.active FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(token), now(),
  );
  return row && row.active ? row : null;
}

export function login(email, password, ip) {
  const user = one('SELECT * FROM users WHERE email = ? COLLATE NOCASE', String(email || '').trim());
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    audit({ label: String(email || '').slice(0, 120) }, 'auth.sign_in_failed', { meta: { ip } });
    throw new HttpError(401, 'Wrong email or password');
  }
  audit(user, 'auth.sign_in', { meta: { ip } });
  return { token: createSession(user.id), user };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'mh_session';

export function authenticate(req, _res, next) {
  req.user = userFromToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  next();
}
export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in required'));
  next();
}
// Role checks run on every API endpoint, not only in the interface (NFR-S1).
export const requirePerm = (perm) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Sign in required'));
  if (!can(req.user, perm)) return next(new HttpError(403, `Your role (${req.user.role}) cannot do this: ${perm}`));
  next();
};

// API keys for machine clients such as Command Center (ANL-13).
export function createApiKey(name, scope) {
  const raw = `mh_${crypto.randomBytes(24).toString('base64url')}`;
  run('INSERT INTO api_keys (name, key_hash, prefix, scope, created_at) VALUES (?,?,?,?,?)', name, sha256(raw), raw.slice(0, 7), scope, now());
  return raw;
}
export const requireApiKey = (scope) => (req, _res, next) => {
  const raw = req.headers['x-api-key'];
  const row = raw && one('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', sha256(raw));
  if (!row || row.scope !== scope) return next(new HttpError(401, 'Valid API key required'));
  req.apiClient = row;
  next();
};

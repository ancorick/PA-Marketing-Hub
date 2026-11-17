import crypto from 'node:crypto';
import { config } from '../config.js';

// ---------- Email and phone normalization (AUD-04, 12.4) ----------
export function cleanEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Comparison form: Gmail-style dots and +tags are ignored for duplicate detection,
// but the stored email keeps what the person typed.
export function emailCmp(email) {
  const e = cleanEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

export const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export const isEmail = (e) => EMAIL_RE.test(cleanEmail(e)) && cleanEmail(e).length <= 254;

export function phoneNorm(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/[^\d+]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (d.startsWith('0') && d.length === 9) d = '+374' + d.slice(1); // Armenian local format
  if (!d.startsWith('+') && d.length === 11 && d.startsWith('374')) d = '+' + d;
  return d.replace(/^\+/, '');
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const emailHash = (email) => sha256(emailCmp(email));

// ---------- Signed tokens (NFR-S5): no personal data in the URL ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
export function signToken(payload, ttlDays = 365) {
  const body = { ...payload, exp: Date.now() + ttlDays * 864e5 };
  const data = b64u(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', config.appSecret).update(data).digest('base64url').slice(0, 32);
  return `${data}.${sig}`;
}
export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', config.appSecret).update(data).digest('base64url').slice(0, 32);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (body.exp && body.exp < Date.now()) return null;
    return body;
  } catch { return null; }
}

// Webhook signatures (EML-04, NFR-S4): HMAC over "timestamp.body", 5-minute replay window.
export function signWebhook(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
export function verifyWebhook(secret, timestamp, rawBody, signature, maxAgeSec = 300) {
  const ts = Number(timestamp);
  if (!ts || !signature) return { ok: false, reason: 'missing signature' };
  if (Math.abs(Date.now() / 1000 - ts) > maxAgeSec) return { ok: false, reason: 'timestamp outside replay window' };
  const expect = signWebhook(secret, ts, rawBody);
  const a = Buffer.from(String(signature)); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
  return { ok: true };
}

// ---------- Fuzzy name matching ----------
export function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
export function nameSimilarity(a, b) {
  const x = (a || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const y = (b || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// ---------- Dates ----------
export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
export const monthOf = (d) => String(d).slice(0, 7);
export const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5);
export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

// ---------- Deterministic PRNG for seeds and simulators ----------
export function prng(seed) {
  let a = typeof seed === 'number' ? seed : [...String(seed)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Not found') => new HttpError(404, what);

export function randomId(bytes = 12) { return crypto.randomBytes(bytes).toString('base64url'); }

// Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF).
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let i = 0; let inQ = false;
  text = String(text).replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
export function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    // Neutralise spreadsheet formula injection in exports.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

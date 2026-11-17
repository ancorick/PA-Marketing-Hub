// Cross-cutting services: activity log (Core Engine mirror), settings, alerts, vault.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { run, one, q, now, json, parse } from '../db.js';

// ---------- Activity log (NFR-S8, 4.3) ----------
export function audit(actor, action, { entity, entityId, reason, meta } = {}) {
  run(
    `INSERT INTO activity_log (actor_id, actor_label, action, entity, entity_id, reason, meta, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    actor?.id ?? null, actor?.email ?? actor?.label ?? 'system', action, entity ?? null,
    entityId == null ? null : String(entityId), reason ?? null, meta ? json(meta) : null, now(),
  );
}

// ---------- Settings ----------
export const DEFAULT_SETTINGS = {
  kill_switch: false,
  newsletter_cadence: { every: 'month', day_of_month: 5, collect_days_before: 5, languages: ['hy', 'en', 'ru'] },
  newsletter_type_weights: { upcoming_events: 1.0, recent_events: 0.7, library: 0.6, graduations: 0.9, hires: 1.0, new_groups: 0.9 },
  guardrails: {
    hard_bounce_rate: 0.05, hard_bounce_window: 1000,
    complaint_rate: 0.003,
    import_first_send_bounce_rate: 0.10,
    soft_bounce_limit: 3, soft_bounce_days: 30,
  },
  warmup_caps: [50, 100, 200, 400, 800, 1500, 2500, 4000, 6000, 9000, 13000, 20000, 30000, 50000],
  batch_size: 100,
  sunset_months: 12,
  attribution_lookback_days: 365,
  cohort_maturity_months: 12,
  small_number_threshold: 3,
  simulate_failure: {},
  disposable_domains: ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com'],
};

export function getSetting(key) {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  return row ? parse(row.value, DEFAULT_SETTINGS[key]) : DEFAULT_SETTINGS[key];
}
export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, json(value), now(),
  );
}
export function allSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of q('SELECT key, value FROM settings')) out[r.key] = parse(r.value);
  return out;
}

// ---------- Alerts: stored, and pushed to Slack when configured ----------
export function raiseAlert(level, kind, message, meta) {
  const recent = one(
    `SELECT id FROM alerts WHERE kind = ? AND message = ? AND resolved_at IS NULL AND created_at > ?`,
    kind, message, new Date(Date.now() - 3600e3).toISOString(),
  );
  if (recent) return recent.id;
  const r = run('INSERT INTO alerts (level, kind, message, meta, created_at) VALUES (?,?,?,?,?)', level, kind, message, meta ? json(meta) : null, now());
  if (config.slackWebhookUrl) {
    fetch(config.slackWebhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[Marketing Hub · ${level}] ${message}` }),
    }).catch(() => {});
  }
  if (config.env !== 'test') console.log(`[alert:${level}] ${kind}: ${message}`);
  return Number(r.lastInsertRowid);
}

// ---------- Vault: AES-256-GCM for integration credentials ----------
const key = () => Buffer.from(config.vaultKey, 'hex');
export function vaultPut(name, value, actorId) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  const blob = [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  run(
    `INSERT INTO secrets (name, ciphertext, updated_at, rotated_by) VALUES (?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, rotated_by = excluded.rotated_by`,
    name, blob, now(), actorId ?? null,
  );
}
export function vaultGet(name) {
  const row = one('SELECT ciphertext FROM secrets WHERE name = ?', name);
  if (!row) return null;
  const [iv, tag, enc] = row.ciphertext.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
export function vaultList() {
  return q('SELECT name, updated_at, rotated_by FROM secrets ORDER BY name').map((r) => {
    const v = vaultGet(r.name) || '';
    return { ...r, preview: v ? `${v.slice(0, 4)}…${v.slice(-2)}` : '' };
  });
}

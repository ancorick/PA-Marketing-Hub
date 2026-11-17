// Email service provider adapters (7.1, EML-01) and ESP webhook processing (EML-04..06).
// "dev" keeps every message in a local outbox and simulates the provider's
// signed webhooks; "smtp" sends through a real SMTP relay via nodemailer.
import { config } from '../../config.js';
import { q, one, run, now, json, tx } from '../../db.js';
import { randomId, signWebhook, verifyWebhook, prng, HttpError } from '../../lib/util.js';
import { getSetting, raiseAlert, vaultGet } from '../../lib/core.js';
import { suppress, unsubscribeAll, getContact } from '../audience.js';

let smtpTransport = null;
async function smtp() {
  if (smtpTransport) return smtpTransport;
  const nodemailer = (await import('nodemailer')).default;
  smtpTransport = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
    auth: { user: config.smtp.user || vaultGet('smtp_user'), pass: config.smtp.pass || vaultGet('smtp_pass') },
  });
  return smtpTransport;
}

/** message: { to, from, subject, html, text, headers, idempotencyKey } -> { messageId } */
export async function espSend(message) {
  const existing = one('SELECT message_id FROM esp_outbox WHERE idempotency_key = ?', message.idempotencyKey);
  if (existing) return { messageId: existing.message_id, duplicate: true };
  const messageId = `<${randomId(10)}@${config.academy.domain}>`;
  if (config.espAdapter === 'smtp') {
    const t = await smtp();
    await t.sendMail({ to: message.to, from: message.from, subject: message.subject, html: message.html, text: message.text, headers: message.headers, messageId });
  }
  run(
    `INSERT INTO esp_outbox (message_id, idempotency_key, to_email, from_header, subject, headers, html, text, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    messageId, message.idempotencyKey, message.to, message.from, message.subject, json(message.headers), message.html, message.text, now(),
  );
  if (config.espAdapter === 'dev' && !message.noSimulation) simulateProviderEvents(messageId, message.to);
  return { messageId };
}

// ---------- Dev provider simulation ----------
// Deterministic outcomes so demos are repeatable: addresses containing
// "bounce" hard-bounce, "soft" soft-bounce, "complain" complain.
export function simulatedOutcome(messageId, email) {
  const r = prng(messageId);
  const local = String(email).split('@')[0];
  if (local.includes('bounce')) return { type: 'bounced', bounce_type: 'hard' };
  if (local.includes('soft')) return { type: 'bounced', bounce_type: 'soft' };
  const events = [{ type: 'delivered' }];
  if (local.includes('complain')) { events.push({ type: 'complained' }); return { multi: events }; }
  if (r() < 0.45) events.push({ type: 'opened' });
  if (r() < 0.12) events.push({ type: 'clicked' });
  return { multi: events };
}

function simulateProviderEvents(messageId, email) {
  if (config.env === 'test') return;
  const outcome = simulatedOutcome(messageId, email);
  const list = outcome.multi || [outcome];
  list.forEach((evt, i) => {
    setTimeout(() => {
      try {
        const body = JSON.stringify({ id: `${messageId}:${evt.type}`, type: evt.type, message_id: messageId, email, bounce_type: evt.bounce_type, timestamp: new Date().toISOString() });
        const ts = Math.floor(Date.now() / 1000);
        handleEspWebhook(body, { 'x-esp-timestamp': String(ts), 'x-esp-signature': signWebhook(config.espWebhookSecret, ts, body) });
      } catch (e) { console.error('simulated webhook failed', e.message); }
    }, 400 + i * 700);
  });
}

// ---------- Webhook entry point (signature verified, idempotent) ----------
export function handleEspWebhook(rawBody, headers) {
  const v = verifyWebhook(config.espWebhookSecret, headers['x-esp-timestamp'], rawBody, headers['x-esp-signature']);
  if (!v.ok) throw new HttpError(401, `Webhook rejected: ${v.reason}`);
  const evt = JSON.parse(rawBody);
  const events = Array.isArray(evt) ? evt : [evt];
  let processed = 0;
  for (const e of events) if (processEspEvent(e)) processed++;
  return { processed };
}

export function processEspEvent(e) {
  if (!e?.id || !e?.type) return false;
  const inserted = run(`INSERT OR IGNORE INTO webhook_events (idempotency_key, source, type, payload, received_at) VALUES (?,?,?,?,?)`, `esp:${e.id}`, 'esp', e.type, json(e), now());
  if (!inserted.changes) return false; // already processed
  return tx(() => {
    if (e.type === 'account_warning') {
      // ESP account warning or suspension: pause every marketing send (7.4).
      run(`UPDATE sends SET status = 'paused', pause_reason = ?, updated_at = ? WHERE status IN ('sending','scheduled')`, `Provider account warning: ${e.message || ''}`, now());
      raiseAlert('critical', 'esp_account', `Email provider account warning: ${e.message || 'check the provider console'}. All marketing sends paused.`);
      run('UPDATE webhook_events SET processed_at = ? WHERE idempotency_key = ?', now(), `esp:${e.id}`);
      return true;
    }
    const d = one('SELECT * FROM deliveries WHERE esp_message_id = ?', e.message_id);
    if (!d) { run('UPDATE webhook_events SET processed_at = ?, error = ? WHERE idempotency_key = ?', now(), 'unknown message', `esp:${e.id}`); return false; }
    const at = e.timestamp || now();
    const g = getSetting('guardrails');
    switch (e.type) {
      case 'delivered':
        run(`UPDATE deliveries SET status = CASE WHEN status IN ('queued','sent') THEN 'delivered' ELSE status END, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`, at, d.id);
        break;
      case 'bounced':
        if (e.bounce_type === 'hard') {
          run(`UPDATE deliveries SET status = 'bounced_hard' WHERE id = ?`, d.id);
          suppress(d.email, 'hard_bounce');
          run(`UPDATE contacts SET status = 'bounced', updated_at = ? WHERE id = ? AND status = 'active'`, now(), d.contact_id);
        } else {
          run(`UPDATE deliveries SET status = 'bounced_soft' WHERE id = ?`, d.id);
          const n = one(`SELECT COUNT(*) n FROM deliveries WHERE contact_id = ? AND status = 'bounced_soft' AND queued_at >= ?`, d.contact_id, new Date(Date.now() - g.soft_bounce_days * 864e5).toISOString()).n;
          if (n >= g.soft_bounce_limit) {
            suppress(d.email, 'soft_bounce');
            run(`UPDATE contacts SET status = 'bounced', updated_at = ? WHERE id = ?`, now(), d.contact_id);
            raiseAlert('warning', 'soft_bounce', `Contact #${d.contact_id} soft-bounced ${n} times in ${g.soft_bounce_days} days; suppressed for review`, { contactId: d.contact_id });
          }
        }
        break;
      case 'complained':
        run(`UPDATE deliveries SET status = 'complained' WHERE id = ?`, d.id);
        unsubscribeAll(d.contact_id, 'complaint', { sendId: d.send_id });
        break;
      case 'opened':
        run('UPDATE deliveries SET opened_at = COALESCE(opened_at, ?) WHERE id = ?', at, d.id);
        break;
      case 'clicked':
        recordClick(d.id, e.url || null, e.block_id || null, at);
        break;
      case 'unsubscribed':
        unsubscribeAll(d.contact_id, 'link', { sendId: d.send_id, reason: 'provider unsubscribe' });
        break;
      default:
        break;
    }
    run('UPDATE webhook_events SET processed_at = ? WHERE idempotency_key = ?', now(), `esp:${e.id}`);
    return true;
  });
}

// Clicks are a primary engagement signal and an attribution touchpoint (7.5).
export function recordClick(deliveryId, url, blockId, at = now()) {
  const d = one('SELECT d.*, s.campaign_id, s.kind FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.id = ?', deliveryId);
  if (!d) return null;
  run('INSERT INTO link_clicks (delivery_id, block_id, url, clicked_at) VALUES (?,?,?,?)', deliveryId, blockId, url || '', at);
  run('UPDATE deliveries SET first_click_at = COALESCE(first_click_at, ?), opened_at = COALESCE(opened_at, ?) WHERE id = ?', at, at, deliveryId);
  // A click is proof of interest: a contact in re-engagement returns to regular sends (EML-15).
  run(`UPDATE contacts SET engagement = 'normal' WHERE id = ? AND engagement IN ('reengage','sunset')`, d.contact_id);
  const emailCh = one(`SELECT id FROM channels WHERE slug = 'email'`);
  const camp = d.campaign_id ? one('SELECT utm_campaign FROM campaigns WHERE id = ?', d.campaign_id) : null;
  run(
    `INSERT OR IGNORE INTO touchpoints (contact_id, campaign_id, channel_id, type, occurred_at, source_system, source_ref, utm_source, utm_medium, utm_campaign)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    d.contact_id, d.campaign_id, emailCh?.id ?? null, 'click', at, 'esp', `click:${deliveryId}`, d.kind === 'newsletter' ? 'newsletter' : 'email', 'email', camp?.utm_campaign ?? null,
  );
  return d;
}

export function outbox({ limit = 50, to } = {}) {
  return to
    ? q('SELECT id, message_id, to_email, from_header, subject, created_at FROM esp_outbox WHERE to_email LIKE ? ORDER BY id DESC LIMIT ?', `%${to}%`, limit)
    : q('SELECT id, message_id, to_email, from_header, subject, created_at FROM esp_outbox ORDER BY id DESC LIMIT ?', limit);
}
export function outboxMessage(id) {
  const m = one('SELECT * FROM esp_outbox WHERE id = ?', id);
  if (m) m.headers = JSON.parse(m.headers);
  return m;
}

export function simulateAccountWarning(message) {
  return processEspEvent({ id: `warn:${Date.now()}`, type: 'account_warning', message, message_id: null });
}

export const contactOf = (id) => getContact(id);

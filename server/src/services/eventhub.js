// Event Hub as the fourth module (PRD section 10): versioned, signed, idempotent
// webhook contract, plus the manual fallback of 10.5 (form + CSV attendee import).
import { config } from '../config.js';
import { q, one, run, now, json, tx } from '../db.js';
import { verifyWebhook, HttpError, bad, notFound, isoDate, parseCsv, cleanEmail, isEmail } from '../lib/util.js';
import { audit } from '../lib/core.js';
import { upsertContact, isSuppressed, CURRENT_WORDING } from './audience.js';
import { channelBySlug, campaignByUtm, addCost, mapUtm } from './analytics/taxonomy.js';
import { recordTouchpoint } from './analytics/pipeline.js';

export const CONTRACT_VERSION = '1.0';
export const EVENT_TYPES = ['event.created', 'event.updated', 'registration.created', 'registration.cancelled', 'checkin.recorded', 'event.cost_recorded'];

function requireFields(obj, fields, type) {
  const missing = fields.filter((f) => obj?.[f] == null || obj[f] === '');
  if (missing.length) throw bad(`${type}: missing field(s) ${missing.join(', ')}`);
}

// Validate a message against the contract without writing (sandbox, EVT-08).
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') throw bad('Body must be a JSON object');
  requireFields(msg, ['id', 'type', 'version', 'data'], 'message');
  if (!EVENT_TYPES.includes(msg.type)) throw bad(`Unknown type ${msg.type}. Allowed: ${EVENT_TYPES.join(', ')}`);
  if (String(msg.version).split('.')[0] !== CONTRACT_VERSION.split('.')[0]) throw bad(`Unsupported contract version ${msg.version}`);
  const d = msg.data;
  switch (msg.type) {
    case 'event.created': case 'event.updated': requireFields(d, ['event_id', 'title', 'type', 'starts_at'], msg.type); break;
    case 'registration.created': requireFields(d, ['registration_id', 'event_id', 'email'], msg.type); if (!isEmail(d.email)) throw bad('registration.created: invalid email'); break;
    case 'registration.cancelled': requireFields(d, ['registration_id'], msg.type); break;
    case 'checkin.recorded': requireFields(d, ['registration_id', 'checked_in_at'], msg.type); break;
    case 'event.cost_recorded': requireFields(d, ['cost_id', 'event_id', 'amount', 'currency', 'category'], msg.type); break;
    default: break;
  }
  return true;
}

export function handleEventHubWebhook(rawBody, headers) {
  const v = verifyWebhook(config.eventHubSecret, headers['x-eventhub-timestamp'], rawBody, headers['x-eventhub-signature']);
  if (!v.ok) throw new HttpError(401, `Webhook rejected: ${v.reason}`);
  const body = JSON.parse(rawBody);
  const messages = Array.isArray(body) ? body : [body];
  const results = messages.map((m) => ingestMessage(m));
  return { results };
}

/** Process one contract message once (idempotency key = message id). */
export function ingestMessage(msg) {
  validateMessage(msg);
  const key = `event_hub:${msg.id}`;
  const ins = run(`INSERT OR IGNORE INTO webhook_events (idempotency_key, source, type, payload, received_at) VALUES (?,?,?,?,?)`, key, 'event_hub', msg.type, json(msg), now());
  if (!ins.changes) return { id: msg.id, status: 'duplicate' };
  try {
    const out = tx(() => apply(msg));
    run('UPDATE webhook_events SET processed_at = ? WHERE idempotency_key = ?', now(), key);
    return { id: msg.id, status: 'processed', ...out };
  } catch (e) {
    run('UPDATE webhook_events SET error = ? WHERE idempotency_key = ?', String(e.message).slice(0, 300), key);
    throw e;
  }
}

function eventCampaign(externalId, title, at) {
  const ch = channelBySlug('events');
  const utm = `event_${String(externalId).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const c = campaignByUtm(utm, ch.id, { at });
  if (c && c.name !== title) run('UPDATE campaigns SET name = ?, is_recruitment = 1 WHERE id = ?', title, c.id);
  return c;
}

function apply(msg, { source = 'event_hub' } = {}) {
  const d = msg.data;
  const at = msg.occurred_at || now();
  switch (msg.type) {
    case 'event.created':
    case 'event.updated': {
      const camp = eventCampaign(d.event_id, d.title, d.starts_at);
      run(`INSERT INTO events (external_id, title, type, starts_at, is_public, registration_url, language, recording_url, photos_url, media_public, campaign_id, source, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(external_id) DO UPDATE SET title=excluded.title, type=excluded.type, starts_at=excluded.starts_at, is_public=excluded.is_public,
             registration_url=excluded.registration_url, language=excluded.language, recording_url=COALESCE(excluded.recording_url, events.recording_url),
             photos_url=COALESCE(excluded.photos_url, events.photos_url), media_public=excluded.media_public, updated_at=excluded.updated_at`,
      d.event_id, d.title, d.type, d.starts_at, d.public === false ? 0 : 1, d.registration_url || null, d.language || null, d.recording_url || null, d.photos_url || null, d.media_public ? 1 : 0, camp?.id ?? null, source, now());
      return { event: d.event_id };
    }
    case 'registration.created': {
      const ev = one('SELECT * FROM events WHERE external_id = ?', d.event_id);
      if (!ev) throw bad(`Unknown event ${d.event_id}; send event.created first`);
      const consent = {};
      for (const [topic, val] of Object.entries(d.consent || {})) consent[topic] = val ? 'granted' : 'withdrawn';
      const utm = d.utm || {};
      // The registration link's campaign parameters win; otherwise the event itself is the source.
      const touchChannel = utm.utm_source ? mapUtm(utm.utm_source, utm.utm_medium, 'event_hub') : channelBySlug('events').id;
      const { contact } = upsertContact(
        { email: d.email, first_name: d.first_name, last_name: d.last_name, phone: d.phone, language: d.language, core_person_id: d.core_person_id || undefined },
        { method: 'event', consent, wordingVersion: d.consent_wording_version || CURRENT_WORDING, sourceUrl: ev.registration_url, firstTouchAt: d.registered_at || at, channelId: touchChannel ?? undefined, campaignId: utm.utm_source ? undefined : ev.campaign_id, createdAt: d.registered_at || at, consentAt: d.registered_at || at },
      );
      run(`INSERT INTO event_registrations (external_id, event_id, contact_id, registered_at) VALUES (?,?,?,?)
           ON CONFLICT(external_id) DO UPDATE SET contact_id = excluded.contact_id`, d.registration_id, ev.id, contact.id, d.registered_at || at);
      recordTouchpoint({ contactId: contact.id, channelId: touchChannel ?? undefined, campaignId: utm.utm_source ? undefined : ev.campaign_id, type: 'registration', at: d.registered_at || at, sourceSystem: source, sourceRef: `reg:${d.registration_id}`, utm_source: utm.utm_source || 'event', utm_medium: utm.utm_medium || 'offline', utm_campaign: utm.utm_campaign || null });
      return { contact_id: contact.id };
    }
    case 'registration.cancelled':
      run('UPDATE event_registrations SET cancelled_at = ? WHERE external_id = ?', d.cancelled_at || at, d.registration_id);
      return {};
    case 'checkin.recorded': {
      const reg = one('SELECT r.*, e.campaign_id FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.external_id = ?', d.registration_id);
      if (!reg) throw bad(`Unknown registration ${d.registration_id}`);
      run('UPDATE event_registrations SET checked_in_at = ? WHERE id = ?', d.checked_in_at, reg.id);
      recordTouchpoint({ contactId: reg.contact_id, channelId: channelBySlug('events').id, campaignId: reg.campaign_id, type: 'attendance', at: d.checked_in_at, sourceSystem: source, sourceRef: `checkin:${d.registration_id}` });
      return {};
    }
    case 'event.cost_recorded': {
      const ev = one('SELECT * FROM events WHERE external_id = ?', d.event_id);
      if (!ev) throw bad(`Unknown event ${d.event_id}`);
      addCost({ channel_id: channelBySlug('events').id, campaign_id: ev.campaign_id, date_from: isoDate(ev.starts_at), date_to: isoDate(ev.starts_at), amount: d.amount, currency: d.currency, note: `${d.category}${d.note ? ': ' + d.note : ''}` },
        null, { source: 'event_hub', sourceRef: `event_hub:${d.cost_id}` });
      return {};
    }
    default:
      return {};
  }
}

// EVT-07: suppression status for Event Hub (it never sends promotional mail to suppressed contacts).
export const suppressionStatus = (email) => ({ email: cleanEmail(email), suppressed: isSuppressed(email) });

// ---------- Fallback 10.5: manual events and CSV attendee import ----------
export function createManualEvent(data, actor) {
  if (!data.title || !data.type || !data.starts_at) throw bad('Title, type and date are required');
  const id = data.event_id || `manual-${Date.now()}`;
  const r = tx(() => {
    apply({ type: 'event.created', data: { ...data, event_id: id, public: data.public !== false } }, { source: 'manual' });
    if (Number(data.cost_amount) > 0) apply({ type: 'event.cost_recorded', data: { cost_id: `${id}-cost`, event_id: id, amount: Number(data.cost_amount), currency: data.cost_currency || 'AMD', category: 'manual entry' } }, { source: 'manual' });
    return one('SELECT * FROM events WHERE external_id = ?', id);
  });
  audit(actor, 'event.manual_create', { entity: 'event', entityId: r.id, meta: { title: data.title } });
  return r;
}

export function importAttendees(eventId, csvText, actor) {
  const ev = one('SELECT * FROM events WHERE id = ?', eventId);
  if (!ev) throw notFound('Event not found');
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw bad('The file needs a header row and data');
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const col = (names) => h.findIndex((x) => names.includes(x));
  const ce = col(['email', 'e-mail']); const cf = col(['first_name', 'first name', 'name']); const cl = col(['last_name', 'last name', 'surname']);
  const cc = col(['consent', 'newsletter consent', 'newsletter']); const ca = col(['attended', 'checked_in', 'checked in']);
  if (ce < 0) throw bad('No email column found');
  if (cc < 0) throw bad('The fallback import needs a consent column (PRD 10.5)');
  let n = 0; let invalid = 0;
  tx(() => {
    rows.slice(1).forEach((r, i) => {
      const email = cleanEmail(r[ce]);
      if (!isEmail(email)) { invalid++; return; }
      const regId = `${ev.external_id}-csv-${email}`;
      const yes = ['yes', 'y', 'true', '1'].includes(String(r[cc] || '').trim().toLowerCase());
      apply({ type: 'registration.created', data: { registration_id: regId, event_id: ev.external_id, email, first_name: cf >= 0 ? r[cf] : null, last_name: cl >= 0 ? r[cl] : null, consent: { newsletter: yes, events: yes }, registered_at: ev.starts_at } }, { source: 'manual' });
      if (ca < 0 || ['yes', 'y', 'true', '1'].includes(String(r[ca] || '').trim().toLowerCase())) {
        apply({ type: 'checkin.recorded', data: { registration_id: regId, checked_in_at: ev.starts_at } }, { source: 'manual' });
      }
      n++;
    });
  });
  audit(actor, 'event.attendee_import', { entity: 'event', entityId: eventId, meta: { rows: n, invalid } });
  return { imported: n, invalid };
}

export function listEvents() {
  return q(`SELECT e.*, (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.cancelled_at IS NULL) registrations,
            (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.checked_in_at IS NOT NULL) attendees
            FROM events e ORDER BY e.starts_at DESC`);
}
export function setEventMedia(id, data, actor) {
  run('UPDATE events SET recording_url = ?, photos_url = ?, media_public = ?, updated_at = ? WHERE id = ?', data.recording_url || null, data.photos_url || null, data.media_public ? 1 : 0, now(), id);
  audit(actor, 'event.media', { entity: 'event', entityId: id });
  return one('SELECT * FROM events WHERE id = ?', id);
}

export function recentMessages(limit = 30) {
  return q(`SELECT idempotency_key, type, received_at, processed_at, error FROM webhook_events WHERE source = 'event_hub' ORDER BY received_at DESC LIMIT ?`, limit);
}

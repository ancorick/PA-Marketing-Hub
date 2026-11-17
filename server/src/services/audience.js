// Audience module (PRD section 6): one contact base, consent, suppression,
// deduplication and merge, CSV import, erasure.
import { q, one, run, tx, now, json, parse } from '../db.js';
import {
  cleanEmail, emailCmp, emailHash, isEmail, phoneNorm, nameSimilarity, bad, notFound, HttpError, parseCsv,
} from '../lib/util.js';
import { audit, getSetting } from '../lib/core.js';

export const TOPICS = ['newsletter', 'courses', 'events', 'alumni'];
export const TYPES = ['subscriber', 'lead', 'applicant', 'student', 'alumnus'];
const TYPE_RANK = { subscriber: 0, lead: 1, applicant: 2, student: 3, alumnus: 4 };
export const LANGS = ['hy', 'en', 'ru'];
export const CURRENT_WORDING = 'v2';

// ---------- Consent (6.3) ----------
export function consentState(contactId, topic) {
  const r = one('SELECT state, recorded_at, method FROM consent_records WHERE contact_id = ? AND topic = ? ORDER BY id DESC LIMIT 1', contactId, topic);
  return r ? r.state : 'unknown';
}
export function consentMap(contactId) {
  const out = {};
  for (const t of TOPICS) out[t] = consentState(contactId, t);
  return out;
}

// Person-initiated methods may re-grant consent after a withdrawal; imports,
// syncs and staff may never override a withdrawal (rule 3: most restrictive wins).
const PERSON_METHODS = new Set(['form', 'confirm', 'event', 'link']);

export function recordConsent(contactId, topic, state, method, opts = {}) {
  if (!TOPICS.includes(topic)) throw bad(`Unknown consent topic: ${topic}`);
  const current = consentState(contactId, topic);
  if (method === 'manual') {
    // Staff changes always need a reason, and staff can never undo a person's withdrawal.
    if (!opts.reason || String(opts.reason).trim().length < 3) throw bad('A reason is required for manual consent changes');
    const c = getContact(contactId);
    if (state === 'granted' && c?.email && isSuppressed(c.email)) throw new HttpError(409, 'This address is on the suppression list; staff cannot re-grant consent');
    if (state === 'granted' && current === 'withdrawn') throw new HttpError(409, 'The person withdrew consent; only they can opt in again (preferences page or a new sign-up)');
  }
  if (current === state) return { changed: false, state };
  if (current === 'withdrawn' && state !== 'withdrawn' && !PERSON_METHODS.has(method)) {
    return { changed: false, state: current, ignored: 'withdrawal cannot be overridden by ' + method };
  }
  if (current === 'granted' && state === 'unknown') return { changed: false, state: current };
  run(
    `INSERT INTO consent_records (contact_id, topic, state, method, wording_version, source_url, ip, actor_id, reason, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    contactId, topic, state, method, opts.wordingVersion ?? null, opts.sourceUrl ?? null, opts.ip ?? null,
    opts.actor?.id ?? null, opts.reason ?? null, opts.at ?? now(),
  );
  if (method === 'manual') audit(opts.actor, 'consent.manual_change', { entity: 'contact', entityId: contactId, reason: opts.reason, meta: { topic, from: current, to: state } });
  return { changed: true, state };
}

// ---------- Suppression (AUD-12) ----------
export function suppress(email, reason, at = now()) {
  if (!email) return;
  const h = emailHash(email);
  const last = one('SELECT reason FROM suppression WHERE email_hash = ? ORDER BY id DESC LIMIT 1', h);
  if (last && last.reason === reason) return;
  run('INSERT INTO suppression (email_hash, reason, recorded_at) VALUES (?,?,?)', h, reason, at);
}

// A suppressed address never receives marketing email. The only way back from an
// unsubscribe is the person confirming a fresh opt-in themselves (double opt-in).
// Hard bounces, complaints and erasures are permanent.
export function isSuppressed(email) {
  const h = emailHash(email);
  const rows = q('SELECT reason, recorded_at FROM suppression WHERE email_hash = ? ORDER BY id', h);
  if (!rows.length) return false;
  if (rows.some((r) => ['hard_bounce', 'complaint', 'erased'].includes(r.reason))) return true;
  const last = rows[rows.length - 1];
  const c = findByEmail(email);
  if (!c) return true;
  const reconfirmed = one(
    `SELECT 1 FROM consent_records WHERE contact_id = ? AND method = 'confirm' AND state = 'granted' AND recorded_at > ? LIMIT 1`,
    c.id, last.recorded_at,
  );
  return !reconfirmed;
}
export function suppressionReason(email) {
  const r = one('SELECT reason, recorded_at FROM suppression WHERE email_hash = ? ORDER BY id DESC LIMIT 1', emailHash(email));
  return r || null;
}

// ---------- Contacts ----------
export function getContact(id) {
  const c = one('SELECT * FROM contacts WHERE id = ?', id);
  if (c) c.tags = parse(c.tags, []);
  return c;
}
export function findByEmail(email) {
  const e = cleanEmail(email);
  if (!e) return null;
  let c = one('SELECT * FROM contacts WHERE email = ?', e) || one('SELECT * FROM contacts WHERE email_cmp = ? AND merged_into IS NULL ORDER BY id LIMIT 1', emailCmp(e));
  let guard = 0;
  while (c && c.merged_into && guard++ < 10) c = one('SELECT * FROM contacts WHERE id = ?', c.merged_into);
  return c || null;
}

const PROFILE_FIELDS = ['first_name', 'last_name', 'phone', 'language', 'course_family', 'core_person_id', 'employment_status'];

/**
 * Create or update a contact (AUD-01, AUD-02, AUD-20).
 * opts: { channelId, campaignId, firstTouchAt, consent: {topic: state}, method, wordingVersion, sourceUrl, ip, actor, importBatchId }
 */
export function upsertContact(data, opts = {}) {
  return tx(() => {
    const email = cleanEmail(data.email);
    if (email && !isEmail(email)) throw bad(`Invalid email: ${data.email}`);
    let c = null;
    if (data.core_person_id) c = one('SELECT * FROM contacts WHERE core_person_id = ?', data.core_person_id);
    if (!c && email) c = findByEmail(email);
    const ts = now();
    let created = false;
    if (!c) {
      const r = run(
        `INSERT INTO contacts (core_person_id, email, email_cmp, phone, phone_norm, first_name, last_name, language, type,
           course_family, source_channel_id, source_campaign_id, first_touch_at, status, tags, import_batch_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        data.core_person_id || null, email || null, email ? emailCmp(email) : null, data.phone || null, phoneNorm(data.phone),
        data.first_name || null, data.last_name || null, LANGS.includes(data.language) ? data.language : 'hy',
        TYPES.includes(data.type) ? data.type : 'subscriber', data.course_family || null,
        opts.channelId ?? null, opts.campaignId ?? null, opts.firstTouchAt || ts,
        opts.pending ? 'pending' : 'active', json(data.tags || []), opts.importBatchId ?? null,
        opts.createdAt || ts, ts,
      );
      c = one('SELECT * FROM contacts WHERE id = ?', Number(r.lastInsertRowid));
      created = true;
    } else {
      const sets = []; const vals = [];
      for (const f of PROFILE_FIELDS) {
        if (data[f] != null && data[f] !== '' && !c[f]) { sets.push(`${f} = ?`); vals.push(data[f]); }
      }
      if (data.phone && !c.phone_norm) { sets.push('phone_norm = ?'); vals.push(phoneNorm(data.phone)); }
      if (data.type && TYPES.includes(data.type) && TYPE_RANK[data.type] > TYPE_RANK[c.type]) { sets.push('type = ?'); vals.push(data.type); }
      if (email && !c.email && c.status !== 'erased') { sets.push('email = ?, email_cmp = ?'); vals.push(email, emailCmp(email)); }
      // First touch is the earliest one ever recorded.
      if (opts.firstTouchAt && (!c.first_touch_at || opts.firstTouchAt < c.first_touch_at)) {
        sets.push('first_touch_at = ?, source_channel_id = COALESCE(?, source_channel_id), source_campaign_id = COALESCE(?, source_campaign_id)');
        vals.push(opts.firstTouchAt, opts.channelId ?? null, opts.campaignId ?? null);
      } else if (!c.source_channel_id && opts.channelId) {
        sets.push('source_channel_id = ?, source_campaign_id = ?'); vals.push(opts.channelId, opts.campaignId ?? null);
      }
      if (data.tags?.length) {
        const merged = [...new Set([...parse(c.tags, []), ...data.tags])];
        sets.push('tags = ?'); vals.push(json(merged));
      }
      if (sets.length) {
        sets.push('updated_at = ?'); vals.push(ts);
        run(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`, ...vals, c.id);
        c = one('SELECT * FROM contacts WHERE id = ?', c.id);
      }
    }
    const consentResults = {};
    for (const [topic, state] of Object.entries(opts.consent || {})) {
      consentResults[topic] = recordConsent(c.id, topic, state, opts.method || 'form', {
        wordingVersion: opts.wordingVersion, sourceUrl: opts.sourceUrl, ip: opts.ip, actor: opts.actor, at: opts.consentAt,
      });
    }
    c.tags = parse(c.tags, []);
    return { contact: c, created, consent: consentResults };
  });
}

export function updateContact(id, patch, actor) {
  const c = getContact(id);
  if (!c || c.status === 'erased') throw notFound('Contact not found');
  const allowed = ['first_name', 'last_name', 'phone', 'language', 'course_family', 'tags', 'frequency'];
  const sets = []; const vals = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    if (k === 'language' && !LANGS.includes(patch[k])) throw bad('Unknown language');
    sets.push(`${k} = ?`); vals.push(k === 'tags' ? json(patch[k]) : patch[k]);
    if (k === 'phone') { sets.push('phone_norm = ?'); vals.push(phoneNorm(patch[k])); }
  }
  if (!sets.length) return c;
  run(`UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, now(), id);
  audit(actor, 'contact.update', { entity: 'contact', entityId: id, meta: { fields: Object.keys(patch) } });
  return getContact(id);
}

// One-click unsubscribe from all marketing (AUD-09): withdraw every topic and suppress.
export function unsubscribeAll(contactId, method = 'link', meta = {}) {
  return tx(() => {
    const c = getContact(contactId);
    if (!c) throw notFound();
    for (const t of TOPICS) recordConsent(contactId, t, 'withdrawn', method === 'complaint' ? 'complaint' : method, { sourceUrl: meta.sourceUrl, ip: meta.ip, actor: meta.actor, reason: meta.reason || 'unsubscribe' });
    if (c.email) suppress(c.email, method === 'complaint' ? 'complaint' : 'unsubscribed');
    run(`UPDATE contacts SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('erased')`, method === 'complaint' ? 'complained' : 'unsubscribed', now(), contactId);
    // Drop the contact from any queued sends immediately (NFR-F4).
    run('DELETE FROM send_queue WHERE contact_id = ?', contactId);
    if (meta.sendId) run(`UPDATE deliveries SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE send_id = ? AND contact_id = ?`, now(), meta.sendId, contactId);
    audit(meta.actor || { label: 'contact' }, method === 'complaint' ? 'contact.complaint' : 'contact.unsubscribe', { entity: 'contact', entityId: contactId, meta: { method, sendId: meta.sendId } });
    return true;
  });
}

// Preferences page (AUD-11): change topics, language and frequency.
export function updatePreferences(contactId, prefs, meta = {}) {
  return tx(() => {
    const c = getContact(contactId);
    if (!c) throw notFound();
    if (prefs.language && LANGS.includes(prefs.language)) run('UPDATE contacts SET language = ? WHERE id = ?', prefs.language, contactId);
    if (prefs.frequency && ['weekly', 'monthly', 'quarterly'].includes(prefs.frequency)) run('UPDATE contacts SET frequency = ? WHERE id = ?', prefs.frequency, contactId);
    const results = {};
    for (const t of TOPICS) {
      if (prefs.topics && t in prefs.topics) {
        results[t] = recordConsent(contactId, t, prefs.topics[t] ? 'granted' : 'withdrawn', 'link', { sourceUrl: meta.sourceUrl, ip: meta.ip, wordingVersion: CURRENT_WORDING });
      }
    }
    const anyGranted = TOPICS.some((t) => consentState(contactId, t) === 'granted');
    if (!anyGranted) { if (c.email) suppress(c.email, 'unsubscribed'); run(`UPDATE contacts SET status='unsubscribed' WHERE id = ?`, contactId); }
    run('UPDATE contacts SET updated_at = ? WHERE id = ?', now(), contactId);
    return results;
  });
}

// Double opt-in confirmation (AUD-08).
export function confirmSubscription(contactId, meta = {}) {
  return tx(() => {
    const c = getContact(contactId);
    if (!c) throw notFound();
    for (const t of TOPICS) {
      const r = one('SELECT state FROM consent_records WHERE contact_id = ? AND topic = ? ORDER BY id DESC LIMIT 1', contactId, t);
      if (r?.state === 'pending') recordConsent(contactId, t, 'granted', 'confirm', { ip: meta.ip, wordingVersion: CURRENT_WORDING });
    }
    if (['pending', 'unsubscribed'].includes(c.status)) run(`UPDATE contacts SET status = 'active', updated_at = ? WHERE id = ?`, now(), contactId);
    return getContact(contactId);
  });
}

// ---------- Duplicate detection and merge (AUD-04, AUD-05) ----------
export function mergeSuggestions(limit = 50) {
  const dismissed = new Set(q('SELECT a, b FROM merge_dismissals').map((r) => `${r.a}:${r.b}`));
  const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const out = new Map();
  const add = (a, b, reason, score) => {
    if (a === b) return;
    const k = key(a, b);
    if (dismissed.has(k)) return;
    const prev = out.get(k);
    if (!prev || prev.score < score) out.set(k, { a: Math.min(a, b), b: Math.max(a, b), reason, score });
  };
  for (const g of q(`SELECT email_cmp, GROUP_CONCAT(id) ids FROM contacts WHERE merged_into IS NULL AND status != 'erased' AND email_cmp IS NOT NULL GROUP BY email_cmp HAVING COUNT(*) > 1`)) {
    const ids = g.ids.split(',').map(Number);
    for (let i = 1; i < ids.length; i++) add(ids[0], ids[i], 'Same normalized email', 0.99);
  }
  for (const g of q(`SELECT phone_norm, GROUP_CONCAT(id) ids FROM contacts WHERE merged_into IS NULL AND status != 'erased' AND phone_norm IS NOT NULL GROUP BY phone_norm HAVING COUNT(*) > 1`)) {
    const ids = g.ids.split(',').map(Number);
    for (let i = 1; i < ids.length; i++) add(ids[0], ids[i], 'Same phone number', 0.9);
  }
  // Name fuzzy match, blocked by last-name prefix to stay fast.
  const people = q(`SELECT id, first_name, last_name FROM contacts WHERE merged_into IS NULL AND status != 'erased' AND last_name IS NOT NULL AND first_name IS NOT NULL`);
  const blocks = new Map();
  for (const p of people) {
    const k = p.last_name.toLowerCase().slice(0, 3);
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(p);
  }
  for (const list of blocks.values()) {
    if (list.length > 400) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = nameSimilarity(`${list[i].first_name} ${list[i].last_name}`, `${list[j].first_name} ${list[j].last_name}`);
        if (s >= 0.88) add(list[i].id, list[j].id, 'Similar name', Math.round(s * 100) / 100 * 0.8);
      }
    }
  }
  const rows = [...out.values()].sort((x, y) => y.score - x.score).slice(0, limit);
  return rows.map((r) => ({ ...r, contactA: getContact(r.a), contactB: getContact(r.b) }));
}

export function dismissSuggestion(a, b) {
  run('INSERT OR IGNORE INTO merge_dismissals (a, b, created_at) VALUES (?,?,?)', Math.min(a, b), Math.max(a, b), now());
}

/** Merge `dropId` into `keepId`: earliest first touch, full history, most restrictive consent. */
export function mergeContacts(keepId, dropId, actor) {
  if (keepId === dropId) throw bad('Cannot merge a contact into itself');
  return tx(() => {
    const keep = getContact(keepId); const drop = getContact(dropId);
    if (!keep || !drop) throw notFound('Contact not found');
    if (keep.merged_into || drop.merged_into) throw bad('One of these contacts is already merged');
    const ts = now();
    // History moves to the surviving record.
    for (const t of ['touchpoints', 'outcomes', 'deliveries', 'event_registrations']) {
      if (t === 'deliveries') {
        run(`UPDATE deliveries SET contact_id = ? WHERE contact_id = ? AND send_id NOT IN (SELECT send_id FROM deliveries WHERE contact_id = ?)`, keepId, dropId, keepId);
      } else run(`UPDATE ${t} SET contact_id = ? WHERE contact_id = ?`, keepId, dropId);
    }
    run('DELETE FROM send_queue WHERE contact_id = ?', dropId);
    run('UPDATE OR IGNORE segment_members SET contact_id = ? WHERE contact_id = ?', keepId, dropId);
    run('DELETE FROM segment_members WHERE contact_id = ?', dropId);
    // Most restrictive consent per topic: withdrawn beats granted beats unknown.
    for (const t of TOPICS) {
      const a = consentState(keepId, t); const b = consentState(dropId, t);
      const strict = [a, b].includes('withdrawn') ? 'withdrawn' : [a, b].includes('granted') ? 'granted' : a;
      if (strict !== a) run(
        `INSERT INTO consent_records (contact_id, topic, state, method, actor_id, reason, recorded_at) VALUES (?,?,?,?,?,?,?)`,
        keepId, t, strict, 'merge', actor?.id ?? null, `merged contact #${dropId}`, ts,
      );
    }
    if (drop.email && isSuppressed(drop.email) && keep.email) {
      const r = suppressionReason(drop.email);
      suppress(keep.email, r?.reason || 'unsubscribed');
    }
    const sets = {
      first_touch_at: [keep.first_touch_at, drop.first_touch_at].filter(Boolean).sort()[0] || keep.first_touch_at,
      source_channel_id: (drop.first_touch_at && (!keep.first_touch_at || drop.first_touch_at < keep.first_touch_at)) ? drop.source_channel_id : keep.source_channel_id,
      source_campaign_id: (drop.first_touch_at && (!keep.first_touch_at || drop.first_touch_at < keep.first_touch_at)) ? drop.source_campaign_id : keep.source_campaign_id,
      type: TYPE_RANK[drop.type] > TYPE_RANK[keep.type] ? drop.type : keep.type,
      phone: keep.phone || drop.phone, phone_norm: keep.phone_norm || drop.phone_norm,
      first_name: keep.first_name || drop.first_name, last_name: keep.last_name || drop.last_name,
      core_person_id: keep.core_person_id || drop.core_person_id,
      tags: json([...new Set([...(keep.tags || []), ...(drop.tags || [])])]),
      status: ['unsubscribed', 'complained', 'bounced'].includes(drop.status) && keep.status === 'active' ? drop.status : keep.status,
    };
    if (!keep.core_person_id && drop.core_person_id) run('UPDATE contacts SET core_person_id = NULL WHERE id = ?', dropId);
    run(
      `UPDATE contacts SET first_touch_at=?, source_channel_id=?, source_campaign_id=?, type=?, phone=?, phone_norm=?, first_name=?, last_name=?, core_person_id=?, tags=?, status=?, updated_at=? WHERE id=?`,
      sets.first_touch_at, sets.source_channel_id, sets.source_campaign_id, sets.type, sets.phone, sets.phone_norm,
      sets.first_name, sets.last_name, sets.core_person_id, sets.tags, sets.status, ts, keepId,
    );
    run('UPDATE contacts SET merged_into = ?, updated_at = ? WHERE id = ?', keepId, ts, dropId);
    audit(actor, 'contact.merge', { entity: 'contact', entityId: keepId, meta: { merged: dropId } });
    return getContact(keepId);
  });
}

// ---------- Erasure (AUD-18, NFR-P4) ----------
export function eraseContact(id, actor, reason = 'erasure request') {
  return tx(() => {
    const c = getContact(id);
    if (!c) throw notFound();
    if (c.email) suppress(c.email, 'erased');
    for (const t of TOPICS) if (consentState(id, t) !== 'withdrawn') {
      run(`INSERT INTO consent_records (contact_id, topic, state, method, actor_id, reason, recorded_at) VALUES (?,?,?,?,?,?,?)`, id, t, 'withdrawn', 'erasure', actor?.id ?? null, reason, now());
    }
    run('UPDATE consent_records SET ip = NULL, source_url = NULL WHERE contact_id = ?', id);
    run(`UPDATE contacts SET email = NULL, email_cmp = NULL, phone = NULL, phone_norm = NULL, first_name = NULL, last_name = NULL,
         core_person_id = NULL, tags = '[]', status = 'erased', updated_at = ? WHERE id = ?`, now(), id);
    run('UPDATE deliveries SET email = ? WHERE contact_id = ?', '[erased]', id);
    run('DELETE FROM send_queue WHERE contact_id = ?', id);
    run('DELETE FROM segment_members WHERE contact_id = ?', id);
    audit(actor, 'contact.erase', { entity: 'contact', entityId: id, reason });
    return true;
  });
}

// Data access request: everything stored about one person (NFR-P4).
export function exportContactData(id) {
  const c = getContact(id);
  if (!c) throw notFound();
  return {
    contact: c,
    consent: q('SELECT topic, state, method, wording_version, source_url, recorded_at FROM consent_records WHERE contact_id = ? ORDER BY id', id),
    touchpoints: q('SELECT type, occurred_at, utm_source, utm_medium, utm_campaign FROM touchpoints WHERE contact_id = ? ORDER BY occurred_at', id),
    emails: q(`SELECT s.name, s.subject, d.status, d.queued_at, d.opened_at, d.first_click_at FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.contact_id = ? ORDER BY d.id`, id),
    events: q(`SELECT e.title, e.starts_at, r.registered_at, r.checked_in_at FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.contact_id = ?`, id),
    outcomes: q('SELECT type, occurred_at, course_id FROM outcomes WHERE contact_id = ? ORDER BY occurred_at', id),
  };
}

// Contact timeline (AUD-16).
export function contactTimeline(id) {
  const items = [];
  for (const r of q('SELECT * FROM consent_records WHERE contact_id = ?', id)) items.push({ at: r.recorded_at, kind: 'consent', text: `${r.topic}: ${r.state} (${r.method}${r.wording_version ? ', wording ' + r.wording_version : ''})`, reason: r.reason });
  for (const r of q(`SELECT d.*, s.name, s.kind FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.contact_id = ?`, id)) {
    items.push({ at: r.queued_at, kind: 'email', text: `${r.kind === 'newsletter' ? 'Newsletter' : 'Email'} "${r.name}" · ${r.status}` });
    if (r.opened_at) items.push({ at: r.opened_at, kind: 'open', text: `Opened "${r.name}" (estimated)` });
    if (r.first_click_at) items.push({ at: r.first_click_at, kind: 'click', text: `Clicked a link in "${r.name}"` });
    if (r.unsubscribed_at) items.push({ at: r.unsubscribed_at, kind: 'unsubscribe', text: `Unsubscribed from "${r.name}"` });
  }
  for (const r of q(`SELECT t.*, ch.name channel FROM touchpoints t LEFT JOIN channels ch ON ch.id = t.channel_id WHERE t.contact_id = ? AND t.type NOT IN ('open','click')`, id)) {
    items.push({ at: r.occurred_at, kind: 'touch', text: `${r.type} via ${r.channel || 'unmapped'}${r.utm_campaign ? ' · ' + r.utm_campaign : ''}` });
  }
  for (const r of q(`SELECT e.title, r.* FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.contact_id = ?`, id)) {
    if (r.checked_in_at) items.push({ at: r.checked_in_at, kind: 'event', text: `Attended "${r.title}"` });
  }
  for (const r of q('SELECT * FROM outcomes WHERE contact_id = ?', id)) items.push({ at: r.occurred_at, kind: 'lifecycle', text: `Became ${r.type}${r.course_id ? ' · ' + r.course_id : ''}` });
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ---------- CSV import (AUD-03, AUD-04, rule 2 of 6.3) ----------
const FIELD_ALIASES = {
  email: ['email', 'e-mail', 'mail', 'email address'],
  first_name: ['first_name', 'first name', 'firstname', 'name', 'given name'],
  last_name: ['last_name', 'last name', 'lastname', 'surname', 'family name'],
  phone: ['phone', 'mobile', 'phone number', 'tel'],
  language: ['language', 'lang'],
  type: ['type', 'contact type'],
  course_family: ['course', 'course_family', 'course family'],
  tags: ['tags', 'tag'],
  consent: ['consent', 'newsletter consent', 'opt-in', 'opt in', 'subscribed'],
};
export function guessMapping(header) {
  const map = {};
  header.forEach((h, i) => {
    const n = h.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) if (aliases.includes(n) && !(field in map)) map[field] = i;
  });
  return map;
}
const truthy = (v) => ['yes', 'y', 'true', '1', 'granted', 'да', 'այո'].includes(String(v).trim().toLowerCase());
const falsy = (v) => ['no', 'n', 'false', '0', 'withdrawn', 'нет', 'ոչ'].includes(String(v).trim().toLowerCase());

export function importCsv(text, { mapping, commit = false, filename, actor, tags = [] } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw bad('The file needs a header row and at least one data row');
  const header = rows[0];
  const map = mapping && Object.keys(mapping).length ? mapping : guessMapping(header);
  if (map.email == null) throw bad('Map a column to "email" before importing', { header, mapping: map });
  const hasConsent = map.consent != null;
  const seen = new Set();
  const preview = { total: rows.length - 1, new: 0, matched: 0, invalid: [], duplicatesInFile: 0, unknownConsent: 0, withdrawnKept: 0, header, mapping: map };
  const parsed = [];
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const get = (f) => (map[f] != null ? (r[map[f]] ?? '').trim() : '');
    const email = cleanEmail(get('email'));
    if (!isEmail(email)) { preview.invalid.push({ line, email: get('email'), error: 'Invalid email' }); return; }
    const key = emailCmp(email);
    if (seen.has(key)) { preview.duplicatesInFile++; return; }
    seen.add(key);
    const existing = findByEmail(email);
    if (existing) preview.matched++; else preview.new++;
    let consent = 'unknown';
    if (hasConsent) consent = truthy(get('consent')) ? 'granted' : falsy(get('consent')) ? 'withdrawn' : 'unknown';
    if (consent === 'unknown') preview.unknownConsent++;
    if (existing && consent === 'granted' && (consentState(existing.id, 'newsletter') === 'withdrawn' || isSuppressed(email))) preview.withdrawnKept++;
    const lang = get('language').toLowerCase();
    parsed.push({
      email, first_name: get('first_name'), last_name: get('last_name'), phone: get('phone'),
      language: LANGS.includes(lang) ? lang : (lang.startsWith('arm') ? 'hy' : lang.startsWith('rus') ? 'ru' : lang.startsWith('eng') ? 'en' : undefined),
      type: TYPES.includes(get('type').toLowerCase()) ? get('type').toLowerCase() : undefined,
      course_family: get('course_family') || undefined,
      tags: [...tags, ...get('tags').split(/[;|]/).map((t) => t.trim()).filter(Boolean)],
      consent,
    });
  });
  if (!commit) return { preview };
  return tx(() => {
    const b = run(
      `INSERT INTO import_batches (filename, rows_total, rows_created, rows_updated, rows_invalid, has_consent_column, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      filename || 'upload.csv', preview.total, 0, 0, preview.invalid.length, hasConsent ? 1 : 0, actor?.id ?? null, now(),
    );
    const batchId = Number(b.lastInsertRowid);
    let created = 0; let updated = 0;
    for (const p of parsed) {
      const { consent, ...data } = p;
      const r = upsertContact(data, { method: 'import', consent: { newsletter: consent }, importBatchId: batchId, actor });
      if (r.created) created++; else updated++;
    }
    run('UPDATE import_batches SET rows_created = ?, rows_updated = ? WHERE id = ?', created, updated, batchId);
    audit(actor, 'contacts.import', { entity: 'import_batch', entityId: batchId, meta: { created, updated, invalid: preview.invalid.length, filename } });
    return { preview, batchId, created, updated };
  });
}

export function lifecycleCounts() {
  return q(`SELECT type, COUNT(*) n FROM contacts WHERE merged_into IS NULL AND status != 'erased' GROUP BY type`);
}

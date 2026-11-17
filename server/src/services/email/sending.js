// Campaign sending (7.3, 7.4, 13.2): drafts, pre-send checks, approval, schedule,
// idempotent batched delivery with warm-up caps, guardrails and a kill switch.
import fs from 'node:fs';
import path from 'node:path';
import { q, one, run, now, json, parse, tx } from '../../db.js';
import { bad, notFound, HttpError, randomId } from '../../lib/util.js';
import { audit, getSetting, setSetting, raiseAlert } from '../../lib/core.js';
import { UPLOAD_DIR, config } from '../../config.js';
import { isSuppressed, consentState, getContact } from '../audience.js';
import { segmentContactIds, getSegment } from '../segments.js';
import { renderEmail, extractLinks } from './render.js';
import { espSend } from './esp.js';
import { getDomain, defaultDomain, isDomainAuthenticated, warmupStatus } from './domains.js';

const EDITABLE = ['name', 'campaign_id', 'segment_id', 'template_id', 'domain_id', 'subject', 'preheader', 'body', 'language', 'topic', 'exclude_active_applicants'];

export function getSend(id) {
  const s = one('SELECT * FROM sends WHERE id = ?', id);
  if (!s) return null;
  s.body = parse(s.body, []);
  s.stats = sendStats(id);
  s.queued = one('SELECT COUNT(*) n FROM send_queue WHERE send_id = ?', id).n;
  return s;
}
export function listSends({ kind } = {}) {
  const rows = kind ? q('SELECT id FROM sends WHERE kind = ? ORDER BY id DESC', kind) : q(`SELECT id FROM sends WHERE kind NOT IN ('test','confirmation') ORDER BY id DESC`);
  return rows.map((r) => {
    const s = getSend(r.id);
    s.segment = s.segment_id ? one('SELECT id, name FROM segments WHERE id = ?', s.segment_id) : null;
    s.campaign = s.campaign_id ? one('SELECT id, name, utm_campaign FROM campaigns WHERE id = ?', s.campaign_id) : null;
    delete s.body;
    return s;
  });
}

export function createSend(data, actor) {
  const domain = data.domain_id ? getDomain(data.domain_id) : defaultDomain();
  const r = run(
    `INSERT INTO sends (kind, name, campaign_id, segment_id, template_id, domain_id, subject, preheader, body, language, topic, exclude_active_applicants, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    data.kind || 'campaign', data.name || 'Untitled campaign', data.campaign_id || null, data.segment_id || null, data.template_id || null,
    domain?.id ?? null, data.subject || '', data.preheader || null, json(data.body || []), data.language || null, data.topic || 'courses',
    data.exclude_active_applicants === false ? 0 : 1, 'draft', actor?.id ?? null, now(), now(),
  );
  const id = Number(r.lastInsertRowid);
  audit(actor, 'send.create', { entity: 'send', entityId: id, meta: { name: data.name } });
  return getSend(id);
}

export function updateSend(id, patch, actor) {
  const s = getSend(id);
  if (!s) throw notFound('Send not found');
  if (['sending', 'sent', 'cancelled'].includes(s.status)) throw bad(`A ${s.status} send cannot be edited`);
  const sets = []; const vals = [];
  for (const k of EDITABLE) if (patch[k] !== undefined) {
    sets.push(`${k} = ?`);
    vals.push(k === 'body' ? json(patch[k]) : k === 'exclude_active_applicants' ? (patch[k] ? 1 : 0) : patch[k]);
  }
  if (!sets.length) return s;
  // Any edit after approval returns it to draft and needs re-approval (NWS-S2).
  const reset = ['approved', 'scheduled', 'paused'].includes(s.status);
  run(`UPDATE sends SET ${sets.join(', ')}, updated_at = ?${reset ? ", status = 'draft', approved_by = NULL, approved_at = NULL, scheduled_at = NULL" : ''} WHERE id = ?`, ...vals, now(), id);
  audit(actor, 'send.update', { entity: 'send', entityId: id, meta: { fields: Object.keys(patch), approvalReset: reset } });
  return getSend(id);
}

// ---------- Pre-send checks (NWS-09, EML-11) ----------
async function headSize(url) {
  try {
    if (url.startsWith('/uploads/')) {
      const p = path.join(UPLOAD_DIR, path.basename(url));
      return fs.existsSync(p) ? fs.statSync(p).size : null;
    }
    const ctl = AbortSignal.timeout(4000);
    const r = await fetch(url, { method: 'HEAD', signal: ctl });
    return Number(r.headers.get('content-length')) || null;
  } catch { return null; }
}
async function linkAlive(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) });
    return r.status < 400 || r.status === 405 ? 'ok' : `HTTP ${r.status}`;
  } catch (e) { return e.name === 'TimeoutError' ? 'timeout' : 'unreachable'; }
}

export async function preSendChecks(sendOrBlocks, { subject, live = false } = {}) {
  const blocks = Array.isArray(sendOrBlocks) ? sendOrBlocks : sendOrBlocks.body;
  const subj = subject ?? sendOrBlocks.subject ?? '';
  const checks = [];
  const add = (key, ok, message, severity = 'error') => checks.push({ key, ok, message, severity: ok ? 'ok' : severity });
  add('subject', !!subj.trim(), subj.trim() ? 'Subject is set' : 'Subject is empty');
  add('subject_length', subj.length <= 70, `Subject is ${subj.length} characters (limit 70)`, 'warning');
  add('content', blocks.length > 0, blocks.length ? `${blocks.length} content blocks` : 'Email has no content');
  // Links: syntax always; live check optional (network).
  const links = extractLinks(blocks);
  const badSyntax = links.filter((l) => { try { return !/^https?:$/.test(new URL(l.url).protocol); } catch { return true; } });
  add('links', badSyntax.length === 0, badSyntax.length ? `Broken links: ${badSyntax.map((l) => l.url).join(', ')}` : `${links.length} links are well-formed`);
  if (live && links.length) {
    const results = await Promise.all(links.slice(0, 25).map(async (l) => ({ ...l, status: await linkAlive(l.url) })));
    const dead = results.filter((r) => r.status !== 'ok');
    add('links_live', dead.length === 0, dead.length ? `Links that did not respond: ${dead.map((d) => `${d.url} (${d.status})`).join(', ')}` : 'All links respond', 'warning');
  }
  const images = blocks.filter((b) => b.type === 'image' && b.src);
  const noAlt = images.filter((b) => !String(b.alt || '').trim());
  add('alt_text', noAlt.length === 0, noAlt.length ? `${noAlt.length} image(s) without alt text` : 'All images have alt text');
  let weight = 0; let unknown = 0;
  for (const img of images) { const s = await headSize(img.src.startsWith('/') ? img.src : img.src); if (s) weight += s; else unknown++; }
  add('image_weight', weight <= 1024 * 1024, `Images total ${(weight / 1024).toFixed(0)} KB${unknown ? ` (${unknown} unknown size)` : ''} (limit 1 MB)`, 'warning');
  // Footer is generated by the renderer: verify it really contains the links.
  const r = renderEmail(blocks, { lang: 'en', topic: 'courses', preview: true, contactId: 1 });
  add('unsubscribe', r.html.includes(r.unsubscribeUrl) && r.text.includes(r.unsubscribeUrl), 'Unsubscribe link present in HTML and plain text');
  add('address', r.html.includes(config.academy.address), 'Physical address present in footer');
  add('plain_text', r.text.length > 40, 'Plain-text version generated');
  return { ok: checks.every((c) => c.ok || c.severity !== 'error'), checks };
}

// ---------- Recipients at send time (AUD-12, AUD-14, AUD-17, EML-15) ----------
export function resolveRecipients(send) {
  const excluded = { suppressed: 0, no_consent: 0, inactive: 0, active_applicants: 0, blocked_import: 0, sunset: 0, language: 0, no_email: 0 };
  if (!send.segment_id) return { ids: [], excluded };
  const ids = segmentContactIds(send.segment_id);
  const blocked = new Set(q('SELECT id FROM import_batches WHERE blocked = 1').map((r) => r.id));
  const out = [];
  for (const id of ids) {
    const c = one('SELECT id, email, status, type, language, import_batch_id, engagement FROM contacts WHERE id = ?', id);
    if (!c?.email) { excluded.no_email++; continue; }
    if (c.status !== 'active') { excluded.inactive++; continue; }
    if (isSuppressed(c.email)) { excluded.suppressed++; continue; }
    if (consentState(c.id, send.topic) !== 'granted') { excluded.no_consent++; continue; }
    if (send.language && c.language !== send.language) { excluded.language++; continue; }
    if (send.exclude_active_applicants && send.topic === 'courses' && c.type === 'applicant') { excluded.active_applicants++; continue; }
    if (c.import_batch_id && blocked.has(c.import_batch_id)) { excluded.blocked_import++; continue; }
    if (c.engagement === 'sunset' && send.kind !== 'reengagement') { excluded.sunset++; continue; }
    out.push(c.id);
  }
  return { ids: out, excluded };
}

export function recipientPreview(id) {
  const s = getSend(id);
  if (!s) throw notFound();
  const r = resolveRecipients(s);
  return { count: r.ids.length, excluded: r.excluded, segment: s.segment_id ? getSegment(s.segment_id) : null };
}

// ---------- Approval and scheduling ----------
export async function approveSend(id, actor, comment) {
  const s = getSend(id);
  if (!s) throw notFound('Send not found');
  if (s.status !== 'draft') throw bad(`Only drafts can be approved (status is ${s.status})`);
  if (!s.segment_id) throw bad('Choose a segment first');
  const domain = getDomain(s.domain_id);
  if (!isDomainAuthenticated(domain)) throw new HttpError(409, 'The sending domain does not pass SPF, DKIM and DMARC; marketing sends are blocked (EML-03)');
  const checks = await preSendChecks(s);
  if (!checks.ok) throw new HttpError(422, 'Pre-send checks failed', checks);
  run(`UPDATE sends SET status = 'approved', approved_by = ?, approved_at = ?, approval_comment = ?, updated_at = ? WHERE id = ?`, actor.id, now(), comment || null, now(), id);
  audit(actor, 'send.approve', { entity: 'send', entityId: id, reason: comment });
  return getSend(id);
}

export function scheduleSend(id, at, actor) {
  const s = getSend(id);
  if (!s) throw notFound();
  if (s.status !== 'approved') throw bad('Approve the send before scheduling it');
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) throw bad('Invalid schedule time');
  run(`UPDATE sends SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?`, when.toISOString(), now(), id);
  audit(actor, 'send.schedule', { entity: 'send', entityId: id, meta: { at: when.toISOString() } });
  return getSend(id);
}

export function cancelSend(id, actor) {
  const s = getSend(id);
  if (!s) throw notFound();
  if (['sent', 'cancelled'].includes(s.status)) throw bad(`Send is already ${s.status}`);
  run(`UPDATE sends SET status = 'cancelled', updated_at = ? WHERE id = ?`, now(), id);
  run('DELETE FROM send_queue WHERE send_id = ?', id);
  audit(actor, 'send.cancel', { entity: 'send', entityId: id });
  return getSend(id);
}
export function pauseSend(id, actor, reason = 'Paused by staff') {
  run(`UPDATE sends SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ? AND status IN ('sending','scheduled')`, reason, now(), id);
  audit(actor, 'send.pause', { entity: 'send', entityId: id, reason });
  return getSend(id);
}
export function resumeSend(id, actor) {
  const s = getSend(id);
  if (!s || s.status !== 'paused') throw bad('Only paused sends can be resumed');
  const next = s.started_at ? 'sending' : 'scheduled';
  run(`UPDATE sends SET status = ?, pause_reason = NULL, updated_at = ? WHERE id = ?`, next, now(), id);
  audit(actor, 'send.resume', { entity: 'send', entityId: id });
  return getSend(id);
}

// ---------- Kill switch (EML-14) ----------
export function setKillSwitch(on, actor) {
  setSetting('kill_switch', !!on);
  audit(actor, on ? 'killswitch.on' : 'killswitch.off');
  if (on) raiseAlert('critical', 'kill_switch', `All sending paused by ${actor?.email || 'system'}`);
  return { kill_switch: !!on };
}

// ---------- Test sends to the seed list (EML-13) ----------
export async function testSend(id, emails, actor) {
  const s = getSend(id);
  if (!s) throw notFound();
  const to = (emails?.length ? emails : q('SELECT email FROM seed_list').map((r) => r.email)).slice(0, 20);
  if (!to.length) throw bad('Add at least one address to the seed list');
  const domain = getDomain(s.domain_id) || defaultDomain();
  for (const email of to) {
    const r = renderEmail(s.body, { lang: s.language || 'en', topic: s.topic, subject: s.subject, preheader: s.preheader, preview: true, contactId: 0 });
    await espSend({ to: email, from: `${domain.from_name} <${domain.from_address}>`, subject: `[TEST] ${s.subject}`, html: r.html, text: r.text, headers: r.headers, idempotencyKey: `test:${id}:${email}:${randomId(4)}`, noSimulation: true });
  }
  audit(actor, 'send.test', { entity: 'send', entityId: id, meta: { to } });
  return { sentTo: to };
}

// ---------- Delivery worker ----------
function engagementPriority(contactId) {
  const r = one(`SELECT MAX(first_click_at) c, MAX(opened_at) o FROM deliveries WHERE contact_id = ?`, contactId);
  let p = 0;
  if (r?.c) p += 2 - Math.min(1, (Date.now() - new Date(r.c)) / (365 * 864e5));
  if (r?.o) p += 1 - Math.min(1, (Date.now() - new Date(r.o)) / (365 * 864e5));
  return p;
}

export function startSend(id) {
  return tx(() => {
    const s = getSend(id);
    const { ids, excluded } = resolveRecipients(s);
    for (const cid of ids) run('INSERT OR IGNORE INTO send_queue (send_id, contact_id, priority) VALUES (?,?,?)', id, cid, engagementPriority(cid));
    run(`UPDATE sends SET status = 'sending', started_at = COALESCE(started_at, ?), recipient_count = ?, updated_at = ? WHERE id = ?`, now(), ids.length, now(), id);
    audit({ label: 'system' }, 'send.start', { entity: 'send', entityId: id, meta: { recipients: ids.length, excluded } });
    return { recipients: ids.length, excluded };
  });
}

const failures = new Map();

export async function deliverBatch(send) {
  const domain = getDomain(send.domain_id);
  if (!isDomainAuthenticated(domain)) { pauseSend(send.id, { label: 'system' }, 'Sending domain lost authentication'); return 0; }
  const w = warmupStatus(domain);
  let limit = getSetting('batch_size');
  if (!w.done) limit = Math.min(limit, w.remaining);
  if (limit <= 0) return 0; // warm-up cap reached for today; resume tomorrow
  const rows = q('SELECT contact_id FROM send_queue WHERE send_id = ? ORDER BY priority DESC, contact_id LIMIT ?', send.id, limit);
  let sent = 0;
  for (const { contact_id: cid } of rows) {
    if (getSetting('kill_switch')) break;
    const c = getContact(cid);
    // Re-check at the moment of sending: an unsubscribe a minute ago must win.
    if (!c?.email || c.status !== 'active' || isSuppressed(c.email) || consentState(cid, send.topic) !== 'granted') {
      run('DELETE FROM send_queue WHERE send_id = ? AND contact_id = ?', send.id, cid);
      continue;
    }
    // Idempotency (EML-10): one delivery row per (send, contact), created before the ESP call.
    const ins = run(`INSERT OR IGNORE INTO deliveries (send_id, contact_id, email, status, queued_at) VALUES (?,?,?,?,?)`, send.id, cid, c.email, 'queued', now());
    const d = one('SELECT * FROM deliveries WHERE send_id = ? AND contact_id = ?', send.id, cid);
    if (!ins.changes && d.esp_message_id) { run('DELETE FROM send_queue WHERE send_id = ? AND contact_id = ?', send.id, cid); continue; }
    const camp = send.campaign_id ? one('SELECT utm_campaign FROM campaigns WHERE id = ?', send.campaign_id) : null;
    const issue = send.kind === 'newsletter' ? one('SELECT archive_slug FROM issues WHERE send_id = ?', send.id) : null;
    const r = renderEmail(send.body, {
      lang: c.language, topic: send.topic, subject: send.subject, preheader: send.preheader, campaign: camp?.utm_campaign,
      deliveryId: d.id, contactId: cid, sendId: send.id, archiveUrl: issue?.archive_slug ? `${config.baseUrl}/archive/${issue.archive_slug}` : null,
    });
    try {
      const res = await espSend({
        to: c.email, from: `${domain.from_name} <${domain.from_address}>`, subject: send.subject, html: r.html, text: r.text,
        headers: r.headers, idempotencyKey: `send:${send.id}:${cid}`,
      });
      run(`UPDATE deliveries SET esp_message_id = ?, status = CASE WHEN status = 'queued' THEN 'sent' ELSE status END WHERE id = ?`, res.messageId, d.id);
      run('DELETE FROM send_queue WHERE send_id = ? AND contact_id = ?', send.id, cid);
      sent++;
    } catch (e) {
      const key = `${send.id}:${cid}`;
      const n = (failures.get(key) || 0) + 1;
      failures.set(key, n);
      if (n >= 3) {
        run(`UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?`, String(e.message).slice(0, 300), d.id);
        run('DELETE FROM send_queue WHERE send_id = ? AND contact_id = ?', send.id, cid);
      }
      break; // back off: retry this contact on the next tick
    }
  }
  run('UPDATE sends SET sent_count = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND esp_message_id IS NOT NULL) WHERE id = ?', send.id, send.id);
  return sent;
}

// Guardrails (7.4): pause a send before one bad list damages the domain.
export function evaluateGuardrails(sendId) {
  const g = getSetting('guardrails');
  const s = getSend(sendId);
  if (!s || !['sending', 'sent'].includes(s.status)) return null;
  const first = q(`SELECT status FROM deliveries WHERE send_id = ? AND esp_message_id IS NOT NULL ORDER BY id LIMIT ?`, sendId, g.hard_bounce_window);
  const hard = first.filter((d) => d.status === 'bounced_hard').length;
  if (s.status === 'sending' && first.length >= 50 && hard / first.length > g.hard_bounce_rate) {
    pauseSend(sendId, { label: 'guardrail' }, `Hard bounce rate ${(100 * hard / first.length).toFixed(1)}% in the first ${first.length} messages (limit ${g.hard_bounce_rate * 100}%)`);
    raiseAlert('critical', 'guardrail_bounce', `Send "${s.name}" paused: hard bounce rate ${(100 * hard / first.length).toFixed(1)}%`, { sendId });
    return 'paused_bounce';
  }
  const st = sendStats(sendId);
  if (s.status === 'sending' && st.delivered >= 200 && st.complained / st.delivered > g.complaint_rate) {
    pauseSend(sendId, { label: 'guardrail' }, `Complaint rate ${(100 * st.complained / st.delivered).toFixed(2)}% (limit ${g.complaint_rate * 100}%)`);
    raiseAlert('critical', 'guardrail_complaint', `Send "${s.name}" paused: complaint rate ${(100 * st.complained / st.delivered).toFixed(2)}%`, { sendId });
    return 'paused_complaint';
  }
  // An import's first send that bounces > 10% blocks the import until reviewed.
  for (const b of q(`SELECT c.import_batch_id id, COUNT(*) n, SUM(d.status = 'bounced_hard') hb FROM deliveries d JOIN contacts c ON c.id = d.contact_id
                     WHERE d.send_id = ? AND c.import_batch_id IS NOT NULL AND d.esp_message_id IS NOT NULL GROUP BY c.import_batch_id`, sendId)) {
    const earlier = one(`SELECT COUNT(*) n FROM deliveries d JOIN contacts c ON c.id = d.contact_id WHERE c.import_batch_id = ? AND d.send_id < ?`, b.id, sendId).n;
    if (!earlier && b.n >= 20 && b.hb / b.n > g.import_first_send_bounce_rate) {
      const already = one('SELECT blocked FROM import_batches WHERE id = ?', b.id);
      if (!already?.blocked) {
        run('UPDATE import_batches SET blocked = 1, blocked_reason = ? WHERE id = ?', `First send hard bounce rate ${(100 * b.hb / b.n).toFixed(1)}%`, b.id);
        run('DELETE FROM send_queue WHERE contact_id IN (SELECT id FROM contacts WHERE import_batch_id = ?)', b.id);
        raiseAlert('warning', 'guardrail_import', `Import #${b.id} blocked: ${(100 * b.hb / b.n).toFixed(1)}% hard bounces on its first send`, { importBatchId: b.id });
      }
    }
  }
  return 'ok';
}

let running = false;
export async function workerTick() {
  if (running) return;
  running = true;
  try {
    if (getSetting('kill_switch')) return;
    for (const s of q(`SELECT id FROM sends WHERE status = 'scheduled' AND scheduled_at <= ?`, now())) startSend(s.id);
    for (const { id } of q(`SELECT id FROM sends WHERE status = 'sending' ORDER BY id`)) {
      const s = getSend(id);
      await deliverBatch(s);
      evaluateGuardrails(id);
      const left = one('SELECT COUNT(*) n FROM send_queue WHERE send_id = ?', id).n;
      const cur = one('SELECT status FROM sends WHERE id = ?', id).status;
      if (!left && cur === 'sending') {
        run(`UPDATE sends SET status = 'sent', finished_at = ?, updated_at = ? WHERE id = ?`, now(), now(), id);
        if (s.kind === 'newsletter') run(`UPDATE issues SET status = 'sent', updated_at = ? WHERE send_id = ?`, now(), id);
      }
    }
  } catch (e) {
    console.error('send worker error', e);
  } finally {
    running = false;
  }
}

// ---------- Reporting (EML-16, NWS-13) ----------
export function sendStats(id) {
  const r = one(`SELECT COUNT(*) total,
      SUM(esp_message_id IS NOT NULL) sent,
      SUM(status = 'delivered' OR (status IN ('complained') AND delivered_at IS NOT NULL)) delivered,
      SUM(status = 'bounced_hard') bounced_hard, SUM(status = 'bounced_soft') bounced_soft,
      SUM(status = 'complained') complained, SUM(status = 'failed') failed,
      SUM(opened_at IS NOT NULL) opened, SUM(first_click_at IS NOT NULL) clicked, SUM(unsubscribed_at IS NOT NULL) unsubscribed
    FROM deliveries WHERE send_id = ?`, id);
  const o = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0]));
  const base = o.delivered || 0;
  o.click_rate = base ? o.clicked / base : null;
  o.open_rate_estimated = base ? o.opened / base : null;
  o.hard_bounce_rate = o.sent ? o.bounced_hard / o.sent : null;
  o.complaint_rate = base ? o.complained / base : null;
  return o;
}

export function sendReport(id) {
  const s = getSend(id);
  if (!s) throw notFound();
  const stats = s.stats;
  const blocks = q(`SELECT lc.block_id, COUNT(DISTINCT lc.delivery_id) unique_clicks, COUNT(*) clicks FROM link_clicks lc JOIN deliveries d ON d.id = lc.delivery_id
                    WHERE d.send_id = ? GROUP BY lc.block_id ORDER BY unique_clicks DESC`, id);
  const since = s.started_at || s.created_at;
  const until = new Date(new Date(since).getTime() + 30 * 864e5).toISOString();
  // Downstream actions whose touch history includes this send (a click on it).
  const clickers = `SELECT DISTINCT contact_id FROM deliveries WHERE send_id = ? AND first_click_at IS NOT NULL`;
  const applications = one(`SELECT COUNT(DISTINCT o.contact_id) n FROM outcomes o WHERE o.type = 'applied' AND o.occurred_at BETWEEN ? AND ? AND o.contact_id IN (${clickers})`, since, until, id).n;
  const registrations = one(`SELECT COUNT(*) n FROM event_registrations r WHERE r.registered_at BETWEEN ? AND ? AND r.contact_id IN (${clickers})`, since, until, id).n;
  const final = s.started_at && Date.now() - new Date(s.started_at) >= 7 * 864e5;
  return { send: { id: s.id, name: s.name, subject: s.subject, status: s.status, started_at: s.started_at, finished_at: s.finished_at, recipient_count: s.recipient_count }, stats, blocks, applications, registrations, final };
}

// ---------- Sunset policy (EML-15) ----------
export function runSunsetPolicy(actor = { label: 'system' }) {
  const months = getSetting('sunset_months');
  const cutoff = new Date(Date.now() - months * 30 * 864e5).toISOString();
  // Contacts who got mail in the window but never opened or clicked during it.
  const stale = q(`SELECT c.id FROM contacts c WHERE c.status = 'active' AND c.engagement = 'normal' AND c.created_at < ?
      AND EXISTS (SELECT 1 FROM deliveries d WHERE d.contact_id = c.id AND d.queued_at >= ?)
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.contact_id = c.id AND (d.opened_at >= ? OR d.first_click_at >= ?))`, cutoff, cutoff, cutoff, cutoff).map((r) => r.id);
  // Re-engagement emails older than 30 days without a click move contacts out of regular sends.
  const expired = q(`SELECT DISTINCT d.contact_id id FROM deliveries d JOIN sends s ON s.id = d.send_id JOIN contacts c ON c.id = d.contact_id
      WHERE s.kind = 'reengagement' AND d.queued_at < ? AND d.first_click_at IS NULL AND c.engagement = 'reengage'`, new Date(Date.now() - 30 * 864e5).toISOString()).map((r) => r.id);
  for (const id of expired) run(`UPDATE contacts SET engagement = 'sunset', updated_at = ? WHERE id = ?`, now(), id);
  let sendId = null;
  if (stale.length) {
    tx(() => {
      const seg = Number(run(`INSERT INTO segments (name, description, rule, type, owner_id, updated_at) VALUES (?,?,?,?,?,?)`,
        `Re-engagement ${now().slice(0, 10)}`, `Contacts with no opens or clicks for ${months} months`, json({ match: 'all', conditions: [] }), 'static', null, now()).lastInsertRowid);
      for (const id of stale) { run('INSERT OR IGNORE INTO segment_members (segment_id, contact_id) VALUES (?,?)', seg, id); run(`UPDATE contacts SET engagement = 'reengage' WHERE id = ?`, id); }
      run('UPDATE segments SET last_count = ? WHERE id = ?', stale.length, seg);
      sendId = createSend({
        kind: 'reengagement', name: `Re-engagement ${now().slice(0, 10)}`, segment_id: seg, topic: 'newsletter', subject: 'Do you still want news from the Academy?',
        body: [
          { id: 'h1', type: 'heading', text: 'Should we keep writing to you?' },
          { id: 't1', type: 'text', text: 'We have not heard from you in a while. If you still want course news, events and alumni stories, click below. Otherwise we will stop emailing you soon.' },
          { id: 'b1', type: 'button', label: 'Yes, keep me subscribed', url: `${config.baseUrl}/stay-subscribed` },
        ],
      }, actor).id;
    });
  }
  audit(actor, 'sunset.run', { meta: { stale: stale.length, sunset: expired.length, sendId } });
  return { reengage: stale.length, sunset: expired.length, draftSendId: sendId };
}

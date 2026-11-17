// Staff API. Every route checks the role's permission on the server (NFR-S1).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { UPLOAD_DIR, config } from '../config.js';
import { q, one, run, now, json, parse } from '../db.js';
import { bad, notFound, toCsv, randomId, isEmail } from '../lib/util.js';
import { ah, rateLimit } from '../lib/http.js';
import {
  login, destroySession, parseCookies, SESSION_COOKIE, requireUser, requirePerm, can, permissionsFor, isAggregateOnly,
  hashPassword, createApiKey, ROLES,
} from '../lib/auth.js';
import { audit, getSetting, setSetting, allSettings, vaultPut, vaultList } from '../lib/core.js';
import * as A from '../services/audience.js';
import * as Seg from '../services/segments.js';
import * as Send from '../services/email/sending.js';
import * as Dom from '../services/email/domains.js';
import * as Esp from '../services/email/esp.js';
import { renderEmail } from '../services/email/render.js';
import * as NL from '../services/newsletter.js';
import * as M from '../services/analytics/metrics.js';
import * as Tax from '../services/analytics/taxonomy.js';
import * as Pipe from '../services/analytics/pipeline.js';
import { computeAttribution } from '../services/analytics/attribution.js';
import * as EH from '../services/eventhub.js';

export const router = express.Router();
router.use(express.json({ limit: '6mb' }));

const shape = (req, data) => (isAggregateOnly(req.user) ? M.suppressSmall(data) : data);
const id = (req, k = 'id') => { const n = Number(req.params[k]); if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id'); return n; };

// ---------- Auth ----------
router.post('/auth/login', rateLimit({ windowMs: 60_000, max: 10 }), ah(async (req, res) => {
  const { token, user } = login(req.body?.email, req.body?.password, req.ip);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: config.baseUrl.startsWith('https://'), maxAge: 7 * 864e5, path: '/' });
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}));
router.post('/auth/logout', (req, res) => {
  destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
router.get('/auth/me', requireUser, (req, res) => {
  res.json({
    user: req.user, permissions: permissionsFor(req.user.role), aggregateOnly: isAggregateOnly(req.user),
    killSwitch: getSetting('kill_switch'), espAdapter: config.espAdapter, baseUrl: config.baseUrl,
    openAlerts: one('SELECT COUNT(*) n FROM alerts WHERE resolved_at IS NULL').n,
  });
});
router.patch('/auth/me', requireUser, (req, res) => {
  if (['en', 'hy'].includes(req.body?.ui_language)) run('UPDATE users SET ui_language = ? WHERE id = ?', req.body.ui_language, req.user.id);
  res.json({ ok: true });
});

router.use(requireUser);

// ---------- Analytics (9.6) ----------
router.get('/analytics/overview', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, M.overview(req.query))));
router.get('/analytics/channels/:id', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, M.channelDetail(id(req), req.query))));
router.get('/analytics/campaigns/:id', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, M.campaignDetail(id(req), req.query))));
router.get('/analytics/cohorts', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, M.cohorts({ months: Math.min(36, Number(req.query.months) || 18), channelId: req.query.channel ? Number(req.query.channel) : null, model: req.query.model || 'first_touch' }))));
router.get('/analytics/audience', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, M.audienceStats())));
router.get('/analytics/events', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, M.eventsView(req.query))));
router.get('/analytics/newsletter', requirePerm('dashboard.view'), (req, res) => res.json(M.newsletterTrends()));
router.get('/analytics/definitions', requirePerm('dashboard.view'), (req, res) => res.json(M.DEFINITIONS));
router.get('/analytics/health', requirePerm('dashboard.view'), (req, res) => res.json(Pipe.dataHealth()));
router.get('/analytics/traffic', requirePerm('dashboard.view'), (req, res) => {
  const r = M.parseRange(req.query);
  res.json({
    web: q(`SELECT ch.name channel, SUM(w.sessions) sessions, SUM(w.conversions) conversions FROM web_traffic w LEFT JOIN channels ch ON ch.id = w.channel_id WHERE w.date BETWEEN ? AND ? GROUP BY w.channel_id ORDER BY sessions DESC`, r.from, r.to),
    social: q(`SELECT platform, SUM(reach) reach, SUM(engagement) engagement, MAX(followers) followers, SUM(lead_forms) lead_forms FROM social_stats WHERE date BETWEEN ? AND ? GROUP BY platform`, r.from, r.to),
  });
});
// ANL-12: CSV export of any table.
router.get('/analytics/export/:view', requirePerm('dashboard.view'), (req, res) => {
  let rows;
  if (req.params.view === 'overview') {
    const o = shape(req, M.overview(req.query));
    rows = [['Channel', 'Leads', 'Applied', 'Enrolled', 'Completed', 'Hired', 'Spend (AMD)', 'Cost per lead (AMD)', 'Cost per enrolled student (AMD)'],
      ...o.channels.map((c) => [c.channel, c.leads, c.applied, c.enrolled, c.completed, c.hired, c.spend, c.cost_per_lead, c.cost_per_enrolled])];
  } else if (req.params.view === 'cohorts') {
    const c = shape(req, M.cohorts({ channelId: req.query.channel ? Number(req.query.channel) : null, model: req.query.model || 'first_touch' }));
    rows = [['Cohort', 'Age (months)', 'Maturing', 'Leads', 'Applied', 'Enrolled', 'Completed', 'Hired', 'Spend (AMD)', 'Cost per enrolled (AMD)', 'Cost per hired (AMD)'],
      ...c.rows.map((r) => [r.cohort, r.age_months, r.maturing ? 'yes' : 'no', r.leads, r.applied, r.enrolled, r.completed, r.hired, r.spend, r.cost_per_enrolled, r.cost_per_hired])];
  } else throw notFound();
  audit(req.user, 'analytics.export', { meta: { view: req.params.view, query: req.query } });
  res.type('text/csv').attachment(`marketing-hub-${req.params.view}.csv`).send(toCsv(rows));
});
router.post('/analytics/pipeline/run', requirePerm('integrations.manage'), ah(async (req, res) => {
  const out = req.body?.source ? [await Pipe.runSource(req.body.source, {}, req.user)] : await Pipe.runAll(req.user, { attribution: false });
  computeAttribution();
  res.json({ results: out });
}));
router.post('/analytics/pipeline/replay', requirePerm('integrations.manage'), (req, res) => res.json(Pipe.replay(req.body?.source, req.user)));
router.post('/analytics/pipeline/simulate-failure', requirePerm('integrations.manage'), (req, res) => {
  const cur = getSetting('simulate_failure') || {};
  cur[req.body.source] = !!req.body.on;
  setSetting('simulate_failure', cur);
  audit(req.user, 'pipeline.simulate_failure', { meta: req.body });
  res.json(cur);
});
router.post('/analytics/unmapped/:id/resolve', requirePerm('costs.edit'), (req, res) => {
  Tax.resolveUnmapped(id(req), Number(req.body?.channel_id), req.user);
  computeAttribution();
  res.json({ ok: true });
});

// ---------- Taxonomy, campaigns, links, costs (9.3, ANL-03..05) ----------
router.get('/channels', (req, res) => res.json(Tax.listChannels()));
router.get('/campaigns', requirePerm('dashboard.view'), (req, res) => res.json(Tax.listCampaigns()));
router.post('/campaigns', requirePerm('campaigns.edit'), (req, res) => res.json(Tax.saveCampaign(req.body, req.user)));
router.put('/campaigns/:id', requirePerm('campaigns.edit'), (req, res) => res.json(Tax.saveCampaign(req.body, req.user, id(req))));
router.get('/links', requirePerm('dashboard.view'), (req, res) => res.json(Tax.listLinks()));
router.post('/links', requirePerm('campaigns.edit'), (req, res) => res.json(Tax.buildLink(req.body, req.user)));
router.get('/costs', requirePerm('dashboard.view'), (req, res) => res.json(Tax.listCosts(req.query)));
router.post('/costs', requirePerm('costs.edit'), (req, res) => { Tax.addCost(req.body, req.user); res.json({ ok: true }); });
router.delete('/costs/:id', requirePerm('costs.edit'), (req, res) => { Tax.deleteCost(id(req), req.user); res.json({ ok: true }); });
router.get('/fx', requirePerm('dashboard.view'), (req, res) => res.json(Tax.listFx()));
router.post('/fx', requirePerm('costs.edit'), (req, res) => { Tax.setFxRate(req.body.currency, req.body.date, Number(req.body.rate), req.user); res.json({ ok: true }); });
router.post('/ads/csv', requirePerm('costs.edit'), ah(async (req, res) => {
  const { parseCsv } = await import('../lib/util.js');
  const rows = parseCsv(req.body?.csv || '');
  if (rows.length < 2) throw bad('CSV needs a header and rows: date, utm_campaign, spend, currency, impressions, clicks, leads');
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const objs = rows.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  if (!objs.every((o) => o.date && o.utm_campaign && o.spend)) throw bad('Each row needs date, utm_campaign and spend');
  const platform = req.body.platform === 'google' ? 'google' : 'meta';
  const n = Pipe.importAdCsv(objs, platform, req.user);
  const dates = objs.map((o) => o.date).sort();
  await Pipe.runSource(platform === 'google' ? 'google_ads' : 'meta_ads', { from: `${dates[0]}T00:00:00.000Z`, to: `${dates.at(-1)}T23:59:59.999Z` }, req.user);
  res.json({ imported: n });
}));

// ---------- Audience (6) ----------
router.get('/contacts', requirePerm('contacts.view'), (req, res) => {
  const where = ['c.merged_into IS NULL']; const p = [];
  if (req.query.search) { where.push('(c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone LIKE ?)'); const s = `%${req.query.search}%`; p.push(s, s, s, s); }
  if (req.query.type) { where.push('c.type = ?'); p.push(req.query.type); }
  if (req.query.status) { where.push('c.status = ?'); p.push(req.query.status); } else where.push(`c.status != 'erased'`);
  if (req.query.language) { where.push('c.language = ?'); p.push(req.query.language); }
  if (req.query.segment) { const ids = Seg.segmentContactIds(Number(req.query.segment)); where.push(`c.id IN (${ids.length ? ids.join(',') : 0})`); }
  const page = Math.max(1, Number(req.query.page) || 1); const size = 50;
  const total = one(`SELECT COUNT(*) n FROM contacts c WHERE ${where.join(' AND ')}`, ...p).n;
  const rows = q(`SELECT c.id, c.email, c.first_name, c.last_name, c.type, c.language, c.status, c.first_touch_at, c.course_family, ch.name source_channel,
      (SELECT state FROM consent_records cr WHERE cr.contact_id = c.id AND cr.topic = 'newsletter' ORDER BY cr.id DESC LIMIT 1) newsletter_consent
      FROM contacts c LEFT JOIN channels ch ON ch.id = c.source_channel_id WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size);
  res.json({ total, page, size, rows });
});
router.get('/contacts/duplicates', requirePerm('contacts.view'), (req, res) => res.json(A.mergeSuggestions(Number(req.query.limit) || 50)));
router.post('/contacts/duplicates/dismiss', requirePerm('contacts.edit'), (req, res) => { A.dismissSuggestion(Number(req.body.a), Number(req.body.b)); res.json({ ok: true }); });
router.post('/contacts/merge', requirePerm('contacts.edit'), (req, res) => res.json(A.mergeContacts(Number(req.body.keep), Number(req.body.drop), req.user)));
router.post('/contacts/import', requirePerm('contacts.edit'), (req, res) => res.json(A.importCsv(req.body.csv || '', { mapping: req.body.mapping, commit: !!req.body.commit, filename: req.body.filename, tags: req.body.tags || [], actor: req.user })));
router.get('/imports', requirePerm('contacts.view'), (req, res) => res.json(q('SELECT i.*, u.name created_by_name FROM import_batches i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.id DESC')));
router.post('/imports/:id/unblock', requirePerm('send.approve'), (req, res) => {
  run('UPDATE import_batches SET blocked = 0, blocked_reason = NULL WHERE id = ?', id(req));
  audit(req.user, 'import.unblock', { entity: 'import_batch', entityId: id(req), reason: req.body?.reason });
  res.json({ ok: true });
});
router.post('/contacts', requirePerm('contacts.edit'), (req, res) => {
  const r = A.upsertContact(req.body, { method: 'manual', actor: req.user });
  audit(req.user, 'contact.create', { entity: 'contact', entityId: r.contact.id });
  res.json(r.contact);
});
router.get('/contacts/:id', requirePerm('contacts.view'), (req, res) => {
  const c = A.getContact(id(req));
  if (!c) throw notFound('Contact not found');
  res.json({
    contact: c, consent: A.consentMap(c.id), consentLog: q('SELECT cr.*, u.name actor FROM consent_records cr LEFT JOIN users u ON u.id = cr.actor_id WHERE cr.contact_id = ? ORDER BY cr.id DESC', c.id),
    suppression: c.email ? A.suppressionReason(c.email) : null, suppressed: c.email ? A.isSuppressed(c.email) : false,
    timeline: A.contactTimeline(c.id),
    source: c.source_channel_id ? one('SELECT name FROM channels WHERE id = ?', c.source_channel_id)?.name : null,
    campaign: c.source_campaign_id ? one('SELECT name FROM campaigns WHERE id = ?', c.source_campaign_id)?.name : null,
    mergedFrom: q('SELECT id, email FROM contacts WHERE merged_into = ?', c.id),
  });
});
router.patch('/contacts/:id', requirePerm('contacts.edit'), (req, res) => res.json(A.updateContact(id(req), req.body, req.user)));
router.post('/contacts/:id/consent', requirePerm('consent.manual'), (req, res) => res.json(A.recordConsent(id(req), req.body.topic, req.body.state, 'manual', { actor: req.user, reason: req.body.reason })));
router.post('/contacts/:id/unsubscribe', requirePerm('contacts.edit'), (req, res) => { A.unsubscribeAll(id(req), 'manual', { actor: req.user, reason: req.body?.reason || 'Unsubscribe request received by staff' }); res.json({ ok: true }); });
router.post('/contacts/:id/erase', requirePerm('consent.manual'), (req, res) => { A.eraseContact(id(req), req.user, req.body?.reason); res.json({ ok: true }); });
router.get('/contacts/:id/export', requirePerm('contacts.export'), (req, res) => {
  const data = A.exportContactData(id(req));
  run('INSERT INTO export_log (user_id, what, row_count, created_at) VALUES (?,?,?,?)', req.user.id, `contact:${id(req)}`, 1, now());
  audit(req.user, 'contact.access_export', { entity: 'contact', entityId: id(req) });
  res.attachment(`contact-${id(req)}.json`).json(data);
});
router.get('/audience/stats', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, M.audienceStats())));
router.get('/audience/wordings', requirePerm('contacts.view'), (req, res) => res.json(q('SELECT * FROM consent_wordings ORDER BY version DESC, topic, language')));

// ---------- Segments (AUD-13..15) ----------
router.get('/segments', requirePerm('dashboard.view'), (req, res) => res.json(Seg.listSegments()));
router.get('/segments/fields', requirePerm('segments.edit'), (req, res) => res.json(Seg.fieldCatalog()));
router.post('/segments/preview', requirePerm('segments.edit'), (req, res) => {
  const ids = Seg.evaluateRule(req.body.rule);
  const sample = ids.slice(0, 10).map((cid) => one('SELECT id, email, first_name, last_name, type, language FROM contacts WHERE id = ?', cid));
  res.json({ count: ids.length, sample });
});
router.get('/segments/:id', requirePerm('dashboard.view'), (req, res) => { const s = Seg.getSegment(id(req)); if (!s) throw notFound(); res.json({ ...s, count: Seg.segmentContactIds(s.id).length }); });
// Static lists can be given as emails (AUD-15); unknown addresses are reported back.
const withEmails = (body) => {
  if (body?.type !== 'static' || !Array.isArray(body.emails)) return { body, unknown: [] };
  const found = []; const unknown = [];
  for (const e of body.emails.slice(0, 5000)) { const c = A.findByEmail(e); if (c) found.push(c.id); else unknown.push(e); }
  return { body: { ...body, contact_ids: found }, unknown };
};
router.post('/segments', requirePerm('segments.edit'), (req, res) => { const { body, unknown } = withEmails(req.body); res.json({ ...Seg.saveSegment(body, req.user), unknown }); });
router.put('/segments/:id', requirePerm('segments.edit'), (req, res) => { const { body, unknown } = withEmails(req.body); res.json({ ...Seg.saveSegment(body, req.user, id(req)), unknown }); });
router.delete('/segments/:id', requirePerm('segments.edit'), (req, res) => { Seg.deleteSegment(id(req), req.user); res.json({ ok: true }); });
router.get('/segments/:id/export', requirePerm('contacts.export'), (req, res) => {
  const ids = Seg.segmentContactIds(id(req));
  const rows = ids.map((cid) => one('SELECT email, first_name, last_name, language, type, course_family FROM contacts WHERE id = ?', cid));
  run('INSERT INTO export_log (user_id, what, segment_id, row_count, created_at) VALUES (?,?,?,?,?)', req.user.id, 'segment', id(req), rows.length, now());
  audit(req.user, 'segment.export', { entity: 'segment', entityId: id(req), meta: { rows: rows.length } });
  res.type('text/csv').attachment(`segment-${id(req)}.csv`).send(toCsv([['email', 'first_name', 'last_name', 'language', 'type', 'course_family'], ...rows.map((r) => Object.values(r))]));
});
router.get('/exports', requirePerm('audit.view'), (req, res) => res.json(q('SELECT e.*, u.name user_name FROM export_log e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 200')));

// ---------- Campaign emails (7, 13.2) ----------
router.get('/sends', requirePerm('dashboard.view'), (req, res) => res.json(Send.listSends({ kind: req.query.kind })));
router.post('/sends', requirePerm('campaigns.edit'), (req, res) => res.json(Send.createSend({ ...req.body, kind: ['campaign', 'invitation'].includes(req.body.kind) ? req.body.kind : 'campaign' }, req.user)));
router.get('/sends/:id', requirePerm('dashboard.view'), (req, res) => { const s = Send.getSend(id(req)); if (!s) throw notFound(); res.json(s); });
router.patch('/sends/:id', requirePerm('campaigns.edit'), (req, res) => res.json(Send.updateSend(id(req), req.body, req.user)));
router.post('/sends/:id/checks', requirePerm('campaigns.edit'), ah(async (req, res) => { const s = Send.getSend(id(req)); if (!s) throw notFound(); res.json(await Send.preSendChecks(s, { live: !!req.body?.live })); }));
router.get('/sends/:id/recipients', requirePerm('campaigns.edit'), (req, res) => res.json(Send.recipientPreview(id(req))));
router.get('/sends/:id/preview', requirePerm('dashboard.view'), (req, res) => {
  const s = Send.getSend(id(req)); if (!s) throw notFound();
  const r = renderEmail(s.body, { lang: req.query.lang || s.language || 'en', topic: s.topic, subject: s.subject, preheader: s.preheader, preview: true, contactId: 0 });
  res.type(req.query.format === 'text' ? 'text/plain' : 'text/html').send(req.query.format === 'text' ? r.text : r.html);
});
router.post('/sends/:id/test', requirePerm('campaigns.edit'), ah(async (req, res) => res.json(await Send.testSend(id(req), req.body?.emails, req.user))));
router.post('/sends/:id/approve', requirePerm('send.approve'), ah(async (req, res) => res.json(await Send.approveSend(id(req), req.user, req.body?.comment))));
router.post('/sends/:id/schedule', requirePerm('send.approve'), (req, res) => res.json(Send.scheduleSend(id(req), req.body?.at, req.user)));
router.post('/sends/:id/cancel', requirePerm('send.approve'), (req, res) => res.json(Send.cancelSend(id(req), req.user)));
router.post('/sends/:id/pause', requirePerm('send.approve'), (req, res) => res.json(Send.pauseSend(id(req), req.user, req.body?.reason || 'Paused by staff')));
router.post('/sends/:id/resume', requirePerm('send.approve'), (req, res) => res.json(Send.resumeSend(id(req), req.user)));
router.get('/sends/:id/report', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, Send.sendReport(id(req)))));
router.get('/sends/:id/deliveries', requirePerm('contacts.view'), (req, res) => res.json(q('SELECT id, contact_id, email, status, queued_at, delivered_at, opened_at, first_click_at, unsubscribed_at, esp_message_id, error FROM deliveries WHERE send_id = ? ORDER BY id DESC LIMIT 500', id(req))));

// ---------- Email settings (7.2, 7.4) ----------
router.get('/email/domains', requirePerm('dashboard.view'), (req, res) => res.json(Dom.listDomains()));
router.post('/email/domains', requirePerm('integrations.manage'), (req, res) => res.json(Dom.createDomain(req.body, req.user)));
router.post('/email/domains/:id/verify', requirePerm('integrations.manage'), ah(async (req, res) => res.json(await Dom.verifyDomain(id(req), req.user))));
router.post('/email/domains/:id/dmarc-policy', requirePerm('integrations.manage'), (req, res) => res.json(Dom.setDmarcPolicy(id(req), req.body.policy, req.user)));
router.post('/email/domains/:id/rotate-dkim', requirePerm('integrations.manage'), (req, res) => res.json(Dom.rotateDkim(id(req), req.user)));
router.get('/email/dmarc', requirePerm('dashboard.view'), (req, res) => res.json(Dom.dmarcSummary()));
router.post('/email/dmarc', requirePerm('integrations.manage'), (req, res) => res.json(Dom.storeDmarcReport(String(req.body?.xml || ''), req.user)));
router.post('/email/killswitch', requirePerm('killswitch'), (req, res) => res.json(Send.setKillSwitch(!!req.body?.on, req.user)));
router.get('/email/seed-list', requirePerm('campaigns.edit'), (req, res) => res.json(q('SELECT * FROM seed_list ORDER BY email')));
router.post('/email/seed-list', requirePerm('campaigns.edit'), (req, res) => {
  if (!isEmail(req.body?.email)) throw bad('Invalid email');
  run('INSERT OR REPLACE INTO seed_list (email, label) VALUES (?,?)', String(req.body.email).toLowerCase(), req.body.label || null);
  res.json({ ok: true });
});
router.delete('/email/seed-list/:email', requirePerm('campaigns.edit'), (req, res) => { run('DELETE FROM seed_list WHERE email = ?', req.params.email); res.json({ ok: true }); });
router.get('/email/outbox', requirePerm('contacts.view'), (req, res) => res.json(Esp.outbox({ limit: Math.min(200, Number(req.query.limit) || 50), to: req.query.to })));
router.get('/email/outbox/:id', requirePerm('contacts.view'), (req, res) => { const m = Esp.outboxMessage(id(req)); if (!m) throw notFound(); res.json(m); });
router.get('/email/guardrails', requirePerm('dashboard.view'), (req, res) => res.json({ guardrails: getSetting('guardrails'), warmup_caps: getSetting('warmup_caps'), batch_size: getSetting('batch_size'), sunset_months: getSetting('sunset_months'), kill_switch: getSetting('kill_switch') }));
router.put('/email/guardrails', requirePerm('integrations.manage'), (req, res) => {
  for (const k of ['guardrails', 'warmup_caps', 'batch_size', 'sunset_months']) if (req.body[k] !== undefined) setSetting(k, req.body[k]);
  audit(req.user, 'settings.guardrails', { meta: req.body });
  res.json({ ok: true });
});
router.post('/email/simulate-warning', requirePerm('integrations.manage'), (req, res) => { Esp.simulateAccountWarning(req.body?.message || 'Sending paused by provider for review'); res.json({ ok: true }); });
router.post('/email/validate', requirePerm('contacts.view'), ah(async (req, res) => res.json(await Dom.validateAddress(req.body?.email))));
router.post('/email/sunset', requirePerm('send.approve'), (req, res) => res.json(Send.runSunsetPolicy(req.user)));

// ---------- Newsletter (8) ----------
router.get('/newsletter/issues', requirePerm('dashboard.view'), (req, res) => res.json(NL.listIssues()));
router.post('/newsletter/issues', requirePerm('newsletter.edit'), ah(async (req, res) => res.json(await NL.createIssues(req.body || {}, req.user))));
router.get('/newsletter/issues/:id', requirePerm('dashboard.view'), (req, res) => { const i = NL.getIssue(id(req)); if (!i) throw notFound(); res.json(i); });
router.patch('/newsletter/issues/:id', requirePerm('newsletter.edit'), (req, res) => res.json(NL.updateIssue(id(req), req.body, req.user)));
router.post('/newsletter/issues/:id/regenerate', requirePerm('newsletter.edit'), ah(async (req, res) => res.json(await NL.generateDraft(id(req), req.user))));
router.post('/newsletter/issues/:id/blocks', requirePerm('newsletter.edit'), (req, res) => res.json(NL.addBlock(id(req), req.body, req.user)));
router.patch('/newsletter/issues/:id/blocks/:blockId', requirePerm('newsletter.edit'), (req, res) => res.json(NL.updateBlock(id(req), id(req, 'blockId'), req.body, req.user)));
router.delete('/newsletter/issues/:id/blocks/:blockId', requirePerm('newsletter.edit'), (req, res) => res.json(NL.removeBlock(id(req), id(req, 'blockId'), req.user)));
router.post('/newsletter/issues/:id/order', requirePerm('newsletter.edit'), (req, res) => res.json(NL.reorderBlocks(id(req), (req.body.order || []).map(Number), req.user)));
router.post('/newsletter/issues/:id/comments', requirePerm('newsletter.edit'), (req, res) => res.json(NL.addComment(id(req), req.body.body, req.user)));
router.post('/newsletter/issues/:id/checks', requirePerm('newsletter.edit'), ah(async (req, res) => res.json(await NL.checkIssue(id(req), { live: !!req.body?.live }))));
router.post('/newsletter/issues/:id/submit', requirePerm('newsletter.edit'), (req, res) => res.json(NL.submitForReview(id(req), req.user)));
router.post('/newsletter/issues/:id/approve', requirePerm('send.approve'), ah(async (req, res) => res.json(await NL.approveIssue(id(req), req.user, req.body?.comment))));
router.post('/newsletter/issues/:id/schedule', requirePerm('send.approve'), (req, res) => res.json(NL.scheduleIssue(id(req), req.user, req.body?.at)));
router.post('/newsletter/issues/:id/unschedule', requirePerm('send.approve'), (req, res) => res.json(NL.unscheduleIssue(id(req), req.user)));
router.post('/newsletter/issues/:id/test', requirePerm('newsletter.edit'), ah(async (req, res) => {
  const issue = NL.getIssue(id(req));
  const tmp = Send.createSend({ kind: 'test', name: `Test: ${issue.title}`, subject: issue.subject || '', preheader: issue.preheader, body: NL.issueToEmailBlocks(issue), language: issue.language, topic: 'newsletter' }, req.user);
  res.json(await Send.testSend(tmp.id, req.body?.emails, req.user));
}));
router.get('/newsletter/issues/:id/report', requirePerm('dashboard.view'), (req, res) => res.json(shape(req, NL.issueReport(id(req)))));
router.get('/newsletter/issues/:id/preview', requirePerm('dashboard.view'), (req, res) => {
  const issue = NL.getIssue(id(req)); if (!issue) throw notFound();
  const r = renderEmail(NL.issueToEmailBlocks(issue), { lang: issue.language, topic: 'newsletter', subject: issue.subject, preheader: issue.preheader, preview: true, contactId: 0 });
  res.type(req.query.format === 'text' ? 'text/plain' : 'text/html').send(req.query.format === 'text' ? r.text : r.html);
});
router.get('/newsletter/settings', requirePerm('dashboard.view'), (req, res) => res.json({ cadence: getSetting('newsletter_cadence'), weights: getSetting('newsletter_type_weights'), next_planned: NL.nextPlannedDate() }));
router.put('/newsletter/settings', requirePerm('send.approve'), (req, res) => {
  if (req.body.cadence) setSetting('newsletter_cadence', req.body.cadence);
  if (req.body.weights) setSetting('newsletter_type_weights', req.body.weights);
  audit(req.user, 'settings.newsletter', { meta: req.body });
  res.json({ ok: true });
});

// Image uploads for newsletter and campaign blocks.
router.post('/uploads', requirePerm('newsletter.edit'), (req, res) => {
  const m = String(req.body?.data || '').match(/^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/);
  if (!m) throw bad('Upload a PNG, JPEG, GIF or WebP image');
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 2 * 1024 * 1024) throw bad('Images must be under 2 MB');
  const name = `${randomId(8)}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  audit(req.user, 'upload.image', { meta: { name, bytes: buf.length } });
  res.json({ url: `/uploads/${name}`, bytes: buf.length });
});

// ---------- Events (Event Hub module, 10) ----------
router.get('/events', requirePerm('dashboard.view'), (req, res) => res.json(EH.listEvents()));
router.post('/events', requirePerm('events.edit'), (req, res) => res.json(EH.createManualEvent(req.body, req.user)));
router.patch('/events/:id/media', requirePerm('events.edit'), (req, res) => res.json(EH.setEventMedia(id(req), req.body, req.user)));
router.post('/events/:id/attendees', requirePerm('events.edit'), (req, res) => res.json(EH.importAttendees(id(req), req.body?.csv || '', req.user)));
router.get('/events/messages', requirePerm('dashboard.view'), (req, res) => res.json(EH.recentMessages()));

// ---------- Alerts ----------
router.get('/alerts', (req, res) => res.json(q('SELECT * FROM alerts ORDER BY resolved_at IS NOT NULL, id DESC LIMIT 100').map((a) => ({ ...a, meta: parse(a.meta) }))));
router.post('/alerts/:id/resolve', (req, res) => { run('UPDATE alerts SET resolved_at = ? WHERE id = ?', now(), id(req)); audit(req.user, 'alert.resolve', { entity: 'alert', entityId: id(req) }); res.json({ ok: true }); });

// ---------- Admin (users, keys, secrets, settings, audit) ----------
router.get('/admin/users', requirePerm('users.manage'), (req, res) => res.json(q('SELECT id, email, name, role, active, ui_language, created_at FROM users ORDER BY id')));
router.post('/admin/users', requirePerm('users.manage'), (req, res) => {
  const { email, name, role, password } = req.body || {};
  if (!isEmail(email) || !name || !ROLES.includes(role) || String(password || '').length < 10) throw bad('Email, name, a valid role and a password of at least 10 characters are required');
  const r = run('INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?,?,?,?,?)', String(email).toLowerCase(), name, role, hashPassword(password), now());
  audit(req.user, 'user.create', { entity: 'user', entityId: r.lastInsertRowid, meta: { email, role } });
  res.json({ id: Number(r.lastInsertRowid) });
});
router.patch('/admin/users/:id', requirePerm('users.manage'), (req, res) => {
  const uid = id(req);
  if (req.body.role !== undefined) { if (!ROLES.includes(req.body.role)) throw bad('Unknown role'); run('UPDATE users SET role = ? WHERE id = ?', req.body.role, uid); }
  if (req.body.active !== undefined) {
    if (uid === req.user.id && !req.body.active) throw bad('You cannot deactivate yourself');
    run('UPDATE users SET active = ? WHERE id = ?', req.body.active ? 1 : 0, uid);
    if (!req.body.active) run('DELETE FROM sessions WHERE user_id = ?', uid);
  }
  if (req.body.password) { if (String(req.body.password).length < 10) throw bad('Password must be at least 10 characters'); run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), uid); }
  audit(req.user, 'user.update', { entity: 'user', entityId: uid, meta: { role: req.body.role, active: req.body.active, password: !!req.body.password } });
  res.json({ ok: true });
});
router.get('/admin/api-keys', requirePerm('integrations.manage'), (req, res) => res.json(q('SELECT id, name, prefix, scope, created_at, revoked_at FROM api_keys ORDER BY id DESC')));
router.post('/admin/api-keys', requirePerm('integrations.manage'), (req, res) => {
  if (!['command_center', 'event_hub'].includes(req.body?.scope)) throw bad('Scope must be command_center or event_hub');
  const key = createApiKey(req.body.name || req.body.scope, req.body.scope);
  audit(req.user, 'apikey.create', { meta: { scope: req.body.scope } });
  res.json({ key, note: 'Copy this key now; it is shown only once.' });
});
router.delete('/admin/api-keys/:id', requirePerm('integrations.manage'), (req, res) => { run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', now(), id(req)); audit(req.user, 'apikey.revoke', { entity: 'api_key', entityId: id(req) }); res.json({ ok: true }); });
router.get('/admin/secrets', requirePerm('integrations.manage'), (req, res) => res.json(vaultList()));
router.put('/admin/secrets/:name', requirePerm('integrations.manage'), (req, res) => {
  if (!/^[a-z0-9_]{2,40}$/.test(req.params.name) || !req.body?.value) throw bad('Name (a-z, 0-9, _) and value are required');
  vaultPut(req.params.name, req.body.value, req.user.id);
  audit(req.user, 'secret.rotate', { meta: { name: req.params.name } });
  res.json({ ok: true });
});
router.get('/admin/integration-info', requirePerm('integrations.manage'), (req, res) => res.json({
  esp_adapter: config.espAdapter,
  esp_webhook_url: `${config.baseUrl}/api/webhooks/esp`,
  event_hub_webhook_url: `${config.baseUrl}/api/integrations/event-hub`,
  event_hub_sandbox_url: `${config.baseUrl}/api/integrations/event-hub/sandbox`,
  signature: 'HMAC-SHA256 hex of "<timestamp>.<raw body>" in X-EventHub-Signature (X-ESP-Signature for the ESP), Unix seconds in X-EventHub-Timestamp; messages older than 5 minutes are rejected.',
  contract_version: EH.CONTRACT_VERSION, event_types: EH.EVENT_TYPES,
  command_center_url: `${config.baseUrl}/api/v1/metrics/overview`,
  ai_assist: !!config.anthropicApiKey, slack: !!config.slackWebhookUrl,
}));
router.get('/admin/settings', requirePerm('integrations.manage'), (req, res) => res.json(allSettings()));
router.get('/admin/audit', requirePerm('audit.view'), (req, res) => {
  const where = []; const p = [];
  if (req.query.action) { where.push('action LIKE ?'); p.push(`${req.query.action}%`); }
  if (req.query.entity) { where.push('entity = ?'); p.push(req.query.entity); }
  res.json(q(`SELECT * FROM activity_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...p, Math.min(500, Number(req.query.limit) || 200)).map((r) => ({ ...r, meta: parse(r.meta) })));
});
router.get('/admin/permissions', requirePerm('users.manage'), async (req, res) => { const { PERMISSIONS } = await import('../lib/auth.js'); res.json(PERMISSIONS); });

export { can, json };

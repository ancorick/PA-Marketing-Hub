// Newsletter module (PRD section 8): collect -> rank -> draft -> write -> edit ->
// approve -> send -> report. The system collects; a person keeps the voice.
import { q, one, run, now, json, parse, tx } from '../db.js';
import { bad, notFound, HttpError, randomId, isoDate } from '../lib/util.js';
import { audit, getSetting, raiseAlert } from '../lib/core.js';
import { config } from '../config.js';
import { channelBySlug } from './analytics/taxonomy.js';
import { createSend, getSend, preSendChecks, sendReport } from './email/sending.js';
import { defaultDomain, isDomainAuthenticated } from './email/domains.js';
import { saveSegment } from './segments.js';
import { draftNewsletterCopy, aiAvailable, describeAiError } from './ai.js';

const L = {
  en: { lead: 'This month at the Academy', upcoming_events: 'Upcoming events', recent_events: 'Recent events', library: 'New in the Library', graduations: 'Graduations', hires: 'Alumni hires', new_groups: 'New groups starting', cta: 'Apply for the next course', ctaText: 'Enrollment is open for the next groups.', register: 'Register', graduated: 'graduates', starts: 'starts', seats: 'seats', at: 'at', title: 'Academy newsletter' },
  hy: { lead: 'Այս ամիս Ակադեմիայում', upcoming_events: 'Առաջիկա միջոցառումներ', recent_events: 'Անցած միջոցառումներ', library: 'Նորություններ գրադարանում', graduations: 'Ավարտական', hires: 'Շրջանավարտների աշխատանք', new_groups: 'Նոր խմբեր', cta: 'Դիմել հաջորդ դասընթացին', ctaText: 'Գրանցումը բաց է հաջորդ խմբերի համար։', register: 'Գրանցվել', graduated: 'շրջանավարտ', starts: 'մեկնարկ', seats: 'տեղ', at: '—', title: 'Ակադեմիայի տեղեկագիր' },
  ru: { lead: 'В этом месяце в Академии', upcoming_events: 'Ближайшие мероприятия', recent_events: 'Прошедшие мероприятия', library: 'Новое в библиотеке', graduations: 'Выпуски', hires: 'Выпускники нашли работу', new_groups: 'Новые группы', cta: 'Подать заявку на курс', ctaText: 'Открыт набор в новые группы.', register: 'Зарегистрироваться', graduated: 'выпускников', starts: 'старт', seats: 'мест', at: 'в', title: 'Рассылка Академии' },
};
export const BLOCK_ORDER = ['lead', 'upcoming_events', 'recent_events', 'library', 'graduations', 'hires', 'new_groups', 'custom'];
const SOURCE_SYSTEM = { upcoming_events: 'event_hub', recent_events: 'event_hub', library: 'library', graduations: 'core', hires: 'alumni', new_groups: 'launchpad' };

// ---------- Collectors (8.2) with publish rules ----------
function collectors(cutOff, until) {
  const nowIso = until;
  const in45 = new Date(new Date(until).getTime() + 45 * 864e5).toISOString();
  const items = [];
  for (const e of q('SELECT * FROM events WHERE starts_at > ? AND starts_at <= ? ORDER BY starts_at', nowIso, in45)) {
    const ok = e.is_public && !!e.registration_url;
    items.push({ type: 'upcoming_events', ref: e.external_id, title: e.title, summary: `${e.type.replace(/_/g, ' ')}`, url: e.registration_url, occurred_at: e.starts_at, publishable: ok, skip: !e.is_public ? 'Event is not public' : !e.registration_url ? 'Registration is not open' : null });
  }
  for (const e of q('SELECT * FROM events WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at DESC', cutOff, nowIso)) {
    const media = e.recording_url || e.photos_url;
    const ok = e.is_public && media && e.media_public;
    items.push({ type: 'recent_events', ref: e.external_id, title: e.title, summary: e.recording_url ? 'Recording available' : 'Photos available', url: e.recording_url || e.photos_url, occurred_at: e.starts_at, publishable: !!ok, skip: ok ? null : !e.is_public ? 'Event is not public' : !media ? 'No recording or photos yet' : 'Recording or photos are not marked public' });
  }
  for (const r of q('SELECT * FROM ext_library WHERE added_at >= ? AND added_at <= ? ORDER BY added_at DESC', cutOff, nowIso)) {
    const legit = /^https:\/\//.test(r.url || '');
    items.push({ type: 'library', ref: r.id, title: r.title, summary: `${r.type}${r.tags ? ' · ' + parse(r.tags, []).join(', ') : ''}`, url: r.url, occurred_at: r.added_at, publishable: !!r.is_public && legit, skip: !r.is_public ? 'Resource is not marked public' : !legit ? 'Link is not a legitimate HTTPS source' : null });
  }
  for (const g of q('SELECT * FROM ext_graduations WHERE graduated_at >= ? AND graduated_at <= ?', cutOff, nowIso)) {
    // Aggregate only; no names (consent rule in 8.2).
    items.push({ type: 'graduations', ref: g.id, title: `${g.course} · ${g.group_code}`, summary: `${g.graduates}`, occurred_at: g.graduated_at, publishable: true, data: { graduates: g.graduates } });
  }
  for (const a of q(`SELECT a.*, p.first_name, p.last_name, p.course FROM ext_alumni a LEFT JOIN ext_core_people p ON p.person_id = a.person_id
                     WHERE a.status = 'employed' AND a.start_date >= ? AND a.start_date <= ?`, cutOff, nowIso)) {
    const ok = !!a.feature_consent;
    items.push({ type: 'hires', ref: a.person_id, title: ok ? `${a.first_name} ${a.last_name ? a.last_name[0] + '.' : ''}`.trim() : 'A graduate', summary: `${a.role} · ${a.company}${a.course ? ' · ' + a.course : ''}`, occurred_at: a.start_date, publishable: ok, skip: ok ? null : 'Graduate has not opted in to be featured' });
  }
  for (const g of q('SELECT * FROM ext_launchpad_groups WHERE created_at >= ? AND created_at <= ?', cutOff, nowIso)) {
    const ok = !!g.open_for_applications && g.start_date > isoDate(nowIso);
    items.push({ type: 'new_groups', ref: g.id, title: g.course, summary: `${g.start_date} · ${g.seats}`, url: `https://${config.academy.domain}/courses`, occurred_at: g.start_date, publishable: ok, skip: ok ? null : 'Group is not open for applications', data: { start_date: g.start_date, seats: g.seats } });
  }
  return items;
}

function score(item, weights, untilIso) {
  const w = weights[item.type] ?? 0.5;
  const days = Math.abs(new Date(item.occurred_at) - new Date(untilIso)) / 864e5;
  return Math.round(w * (1 / (1 + days / 30)) * 1000) / 1000;
}

// ---------- Issues ----------
export function getIssue(id) {
  const i = one('SELECT * FROM issues WHERE id = ?', id);
  if (!i) return null;
  i.subject_options = parse(i.subject_options, []);
  i.blocks = q('SELECT * FROM issue_blocks WHERE issue_id = ? ORDER BY position', id).map((b) => ({ ...b, source_items: parse(b.source_items, []) }));
  i.items = q('SELECT * FROM collected_items WHERE issue_id = ? ORDER BY publishable DESC, score DESC', id).map((x) => ({ ...x, data: parse(x.data) }));
  i.skipped = i.items.filter((x) => !x.publishable);
  i.comments = q('SELECT c.*, u.name FROM issue_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.issue_id = ? ORDER BY c.id', id);
  i.edits = q('SELECT e.*, u.name editor FROM issue_edits e LEFT JOIN users u ON u.id = e.editor_id WHERE e.issue_id = ? ORDER BY e.id DESC LIMIT 100', id);
  i.send = i.send_id ? getSend(i.send_id) : null;
  if (i.send) delete i.send.body;
  i.ai_available = aiAvailable();
  return i;
}
export function listIssues() {
  return q('SELECT id FROM issues ORDER BY planned_send_at DESC, language').map((r) => {
    const i = getIssue(r.id);
    return { id: i.id, title: i.title, language: i.language, status: i.status, cut_off_at: i.cut_off_at, planned_send_at: i.planned_send_at, subject: i.subject, blocks: i.blocks.length, skipped: i.skipped.length, ai_drafted: i.blocks.filter((b) => b.ai_drafted).length, send_id: i.send_id, archive_slug: i.archive_slug };
  });
}

export function nextPlannedDate() {
  const c = getSetting('newsletter_cadence');
  const d = new Date(); d.setUTCHours(9, 0, 0, 0);
  d.setUTCDate(c.day_of_month || 5);
  if (d <= new Date()) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

/** Create an issue per language and generate its draft (NWS-01..03). */
export async function createIssues({ planned_send_at, languages, cut_off_at } = {}, actor) {
  const planned = planned_send_at ? new Date(planned_send_at).toISOString() : nextPlannedDate();
  const langs = languages?.length ? languages : getSetting('newsletter_cadence').languages;
  const ids = [];
  for (const lang of langs) {
    const prev = one(`SELECT planned_send_at FROM issues WHERE language = ? AND status = 'sent' ORDER BY planned_send_at DESC LIMIT 1`, lang);
    const cut = cut_off_at || prev?.planned_send_at || new Date(new Date(planned).getTime() - 31 * 864e5).toISOString();
    const r = run(`INSERT INTO issues (title, language, cut_off_at, planned_send_at, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      `${L[lang].title} · ${planned.slice(0, 7)}`, lang, cut, planned, 'collecting', now(), now());
    const id = Number(r.lastInsertRowid);
    ids.push(id);
    await generateDraft(id, actor);
  }
  audit(actor, 'newsletter.create', { meta: { ids } });
  return ids.map(getIssue);
}

export async function generateDraft(issueId, actor, { regenerate = false } = {}) {
  const issue = one('SELECT * FROM issues WHERE id = ?', issueId);
  if (!issue) throw notFound('Issue not found');
  if (['approved', 'scheduled', 'sent'].includes(issue.status) && !regenerate) throw bad('Approved issues cannot be regenerated');
  const lang = issue.language; const t = L[lang];
  const until = new Date(Math.min(Date.now(), new Date(issue.planned_send_at).getTime())).toISOString();
  const weights = getSetting('newsletter_type_weights');
  const items = collectors(issue.cut_off_at, until).map((i) => ({ ...i, score: score(i, weights, until) }));
  tx(() => {
    run('DELETE FROM collected_items WHERE issue_id = ?', issueId);
    run('DELETE FROM issue_blocks WHERE issue_id = ?', issueId);
    for (const i of items) {
      run(`INSERT INTO collected_items (issue_id, source_system, source_ref, type, title, summary, url, occurred_at, score, publishable, skip_reason, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        issueId, SOURCE_SYSTEM[i.type], String(i.ref), i.type, i.title, i.summary ?? null, i.url || null, i.occurred_at, i.score, i.publishable ? 1 : 0, i.skip ?? null, json(i.data || null));
    }
  });
  const stored = q('SELECT * FROM collected_items WHERE issue_id = ? AND publishable = 1 ORDER BY score DESC', issueId);
  const byType = {};
  for (const s of stored) (byType[s.type] ||= []).push(s);
  for (const k of Object.keys(byType)) byType[k] = byType[k].slice(0, k === 'library' ? 5 : 4);
  const top = stored[0];

  // Template text (deterministic; not marked as AI).
  const leadText = (it) => {
    if (!it) return '';
    const d = parse(it.data, {}) || {};
    const day = it.occurred_at ? new Date(it.occurred_at).toISOString().slice(0, 10) : '';
    switch (it.type) {
      case 'graduations': return `${it.title}: ${d.graduates} ${t.graduated}.`;
      case 'upcoming_events': return `${it.title} — ${day}. ${t.register}: ${it.url || ''}`.trim();
      case 'recent_events': return `${it.title} (${day}).`;
      case 'hires': return `${it.title}: ${it.summary}.`;
      case 'new_groups': return `${it.title}: ${t.starts} ${d.start_date}, ${d.seats} ${t.seats}.`;
      default: return `${it.title}.`;
    }
  };
  const tpl = {
    lead: { title: t.lead, text: leadText(top) },
    summaries: {},
    subject_options: [`${t.lead}: ${top ? top.title : t.title}`.slice(0, 70)],
    preheader: Object.keys(byType).map((k) => t[k]).filter(Boolean).join(' · ').slice(0, 90),
  };
  let ai = null; let aiError = null;
  if (aiAvailable() && stored.length) {
    try {
      ai = await draftNewsletterCopy({ language: lang, blocks: Object.entries(byType).map(([type, list]) => ({ type, items: list })) });
    } catch (e) { aiError = describeAiError(e); raiseAlert('info', 'ai_assist', aiError); }
  }
  const summaryFor = (type) => ai?.block_summaries?.find((b) => b.block_type === type)?.text || '';
  tx(() => {
    let pos = 0;
    const add = (type, fields) => run(
      `INSERT INTO issue_blocks (issue_id, type, position, title, source_items, body, button_label, button_url, ai_drafted, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      issueId, type, pos++, fields.title || null, json(fields.items || []), fields.body || '', fields.button_label || null, fields.button_url || null, fields.ai ? 1 : 0, now(),
    );
    add('lead', { title: ai?.lead?.title || tpl.lead.title, body: ai?.lead?.text || tpl.lead.text, items: top ? [top.id] : [], ai: !!ai?.lead });
    for (const type of ['upcoming_events', 'recent_events', 'library', 'graduations', 'hires', 'new_groups']) {
      if (!byType[type]?.length) continue;
      const s = summaryFor(type);
      add(type, { title: t[type], body: s, items: byType[type].map((x) => x.id), ai: !!s });
    }
    add('custom', { title: t.cta, body: t.ctaText, button_label: t.cta, button_url: `https://${config.academy.domain}/apply` });
    const subj = ai?.subject_options?.[0] || tpl.subject_options[0];
    run(`UPDATE issues SET status = 'draft', subject = ?, preheader = ?, subject_options = ?, approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?`,
      subj, ai?.preheader || tpl.preheader, json(ai?.subject_options || tpl.subject_options), now(), issueId);
  });
  audit(actor, 'newsletter.draft', { entity: 'issue', entityId: issueId, meta: { items: items.length, publishable: stored.length, ai: !!ai, aiError } });
  notifyDraftReady(issueId);
  return { ...getIssue(issueId), ai_error: aiError };
}

function notifyDraftReady(issueId) {
  const i = one('SELECT title, language FROM issues WHERE id = ?', issueId);
  // NWS-04: Slack + email notification (Slack via webhook when configured).
  raiseAlert('info', 'newsletter_draft', `Newsletter draft ready: ${i.title} (${i.language}) — ${config.baseUrl}/newsletter/${issueId}`);
}

// ---------- Editing (NWS-05, NWS-17); any edit after approval returns the issue to draft ----------
function touchIssue(issueId, actor) {
  const i = one('SELECT status FROM issues WHERE id = ?', issueId);
  if (!i) throw notFound('Issue not found');
  if (['scheduled', 'sent'].includes(i.status)) throw bad(`A ${i.status} issue cannot be edited; cancel the schedule first`);
  if (['approved', 'in_review'].includes(i.status)) {
    run(`UPDATE issues SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?`, now(), issueId);
    if (i.status === 'approved') audit(actor, 'newsletter.approval_reset', { entity: 'issue', entityId: issueId });
  } else run('UPDATE issues SET updated_at = ? WHERE id = ?', now(), issueId);
}
function logEdit(issueId, blockId, actor, field, before, after) {
  if (String(before ?? '') === String(after ?? '')) return;
  run('INSERT INTO issue_edits (issue_id, block_id, editor_id, field, before, after, created_at) VALUES (?,?,?,?,?,?,?)', issueId, blockId, actor?.id ?? null, field, before == null ? null : String(before), after == null ? null : String(after), now());
}

export function updateIssue(id, patch, actor) {
  const i = one('SELECT * FROM issues WHERE id = ?', id);
  if (!i) throw notFound();
  tx(() => {
    touchIssue(id, actor);
    for (const k of ['subject', 'preheader', 'title', 'planned_send_at']) if (patch[k] !== undefined) {
      logEdit(id, null, actor, k, i[k], patch[k]);
      run(`UPDATE issues SET ${k} = ? WHERE id = ?`, patch[k], id);
    }
  });
  return getIssue(id);
}

const BLOCK_FIELDS = ['title', 'body', 'image_url', 'image_alt', 'button_label', 'button_url', 'source_items'];
export function updateBlock(issueId, blockId, patch, actor) {
  const b = one('SELECT * FROM issue_blocks WHERE id = ? AND issue_id = ?', blockId, issueId);
  if (!b) throw notFound('Block not found');
  tx(() => {
    touchIssue(issueId, actor);
    for (const k of BLOCK_FIELDS) if (patch[k] !== undefined) {
      const v = k === 'source_items' ? json(patch[k]) : patch[k];
      logEdit(issueId, blockId, actor, k, b[k], v);
      run(`UPDATE issue_blocks SET ${k} = ? WHERE id = ?`, v, blockId);
    }
    // A human edit or explicit acceptance clears the AI marker.
    if (patch.accept_ai || patch.body !== undefined || patch.title !== undefined) run('UPDATE issue_blocks SET ai_drafted = 0 WHERE id = ?', blockId);
    run('UPDATE issue_blocks SET edited_by = ?, updated_at = ? WHERE id = ?', actor?.id ?? null, now(), blockId);
  });
  return getIssue(issueId);
}
export function addBlock(issueId, data, actor) {
  tx(() => {
    touchIssue(issueId, actor);
    const pos = one('SELECT COALESCE(MAX(position), -1) + 1 p FROM issue_blocks WHERE issue_id = ?', issueId).p;
    const r = run(`INSERT INTO issue_blocks (issue_id, type, position, title, body, image_url, image_alt, button_label, button_url, edited_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      issueId, 'custom', pos, data.title || '', data.body || '', data.image_url || null, data.image_alt || null, data.button_label || null, data.button_url || null, actor?.id ?? null, now());
    logEdit(issueId, Number(r.lastInsertRowid), actor, 'block_added', null, data.title || 'custom block');
  });
  return getIssue(issueId);
}
export function removeBlock(issueId, blockId, actor) {
  tx(() => {
    touchIssue(issueId, actor);
    const b = one('SELECT * FROM issue_blocks WHERE id = ? AND issue_id = ?', blockId, issueId);
    if (!b) throw notFound();
    run('DELETE FROM issue_blocks WHERE id = ?', blockId);
    logEdit(issueId, blockId, actor, 'block_removed', b.title, null);
  });
  return getIssue(issueId);
}
export function reorderBlocks(issueId, order, actor) {
  tx(() => {
    touchIssue(issueId, actor);
    order.forEach((blockId, idx) => run('UPDATE issue_blocks SET position = ? WHERE id = ? AND issue_id = ?', idx, blockId, issueId));
    logEdit(issueId, null, actor, 'order', null, order.join(','));
  });
  return getIssue(issueId);
}
export function addComment(issueId, body, actor) {
  if (!String(body || '').trim()) throw bad('Comment is empty');
  run('INSERT INTO issue_comments (issue_id, user_id, body, created_at) VALUES (?,?,?,?)', issueId, actor?.id ?? null, String(body).slice(0, 2000), now());
  return getIssue(issueId);
}

// Issue -> email blocks for the renderer.
export function issueToEmailBlocks(issueOrId) {
  const issue = typeof issueOrId === 'object' ? issueOrId : getIssue(issueOrId);
  const t = L[issue.language];
  const itemMap = new Map(issue.items.map((x) => [x.id, x]));
  const out = [];
  for (const b of issue.blocks) {
    const bid = `b${b.id}`;
    if (b.type === 'lead') {
      out.push({ id: bid, type: 'heading', text: b.title || t.lead });
      if (b.body) out.push({ id: bid, type: 'text', text: b.body });
      if (b.image_url) out.push({ id: bid, type: 'image', src: b.image_url, alt: b.image_alt });
      continue;
    }
    if (b.title) out.push({ id: bid, type: 'heading', text: b.title });
    if (b.body) out.push({ id: bid, type: 'text', text: b.body });
    if (b.image_url) out.push({ id: bid, type: 'image', src: b.image_url, alt: b.image_alt });
    for (const itemId of b.source_items) {
      const it = itemMap.get(itemId);
      if (!it || !it.publishable) continue;
      const d = it.data || {};
      let meta = it.summary;
      if (it.type === 'upcoming_events' || it.type === 'recent_events') meta = `${new Date(it.occurred_at).toISOString().slice(0, 10)} · ${it.summary}`;
      if (it.type === 'graduations') meta = `${d.graduates} ${t.graduated}`;
      if (it.type === 'new_groups') meta = `${t.starts} ${d.start_date} · ${d.seats} ${t.seats}`;
      out.push({ id: bid, type: 'item', title: it.title, meta, url: it.url || null });
    }
    if (b.button_url) out.push({ id: bid, type: 'button', label: b.button_label, url: b.button_url });
  }
  return out;
}

// ---------- Review, approval, scheduling (NWS-08..11) ----------
export async function checkIssue(id, { live = false } = {}) {
  const issue = getIssue(id);
  if (!issue) throw notFound();
  const res = await preSendChecks(issueToEmailBlocks(issue), { subject: issue.subject || '', live });
  const aiLeft = issue.blocks.filter((b) => b.ai_drafted).length;
  res.checks.push({ key: 'ai_text', ok: aiLeft === 0, severity: aiLeft ? 'warning' : 'ok', message: aiLeft ? `${aiLeft} block(s) still hold AI-drafted text nobody has accepted` : 'No unreviewed AI text' });
  return res;
}
export function submitForReview(id, actor) {
  const i = one('SELECT status FROM issues WHERE id = ?', id);
  if (i?.status !== 'draft') throw bad('Only drafts can be submitted for review');
  run(`UPDATE issues SET status = 'in_review', updated_at = ? WHERE id = ?`, now(), id);
  audit(actor, 'newsletter.submit', { entity: 'issue', entityId: id });
  return getIssue(id);
}
export async function approveIssue(id, actor, comment) {
  const issue = getIssue(id);
  if (!issue) throw notFound();
  if (!['draft', 'in_review'].includes(issue.status)) throw bad(`Issue is ${issue.status}`);
  const checks = await checkIssue(id);
  if (!checks.ok) throw new HttpError(422, 'Pre-send checks failed', checks);
  run(`UPDATE issues SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`, actor.id, now(), now(), id);
  if (comment) addComment(id, `Approved: ${comment}`, actor);
  audit(actor, 'newsletter.approve', { entity: 'issue', entityId: id });
  return getIssue(id);
}

export function newsletterSegment(language) {
  const name = `Newsletter · ${language.toUpperCase()}`;
  const s = one('SELECT id FROM segments WHERE name = ?', name);
  if (s) return s.id;
  return saveSegment({ name, description: 'Newsletter consent, preferred language', rule: { match: 'all', conditions: [{ field: 'consent', op: 'granted', value: 'newsletter' }, { field: 'language', op: 'in', value: [language] }] } }, null).id;
}

export function scheduleIssue(id, actor, at) {
  const issue = getIssue(id);
  if (!issue) throw notFound();
  if (issue.status !== 'approved') throw bad('Approve the issue before scheduling it');
  const domain = defaultDomain();
  if (!isDomainAuthenticated(domain)) throw new HttpError(409, 'The sending domain is not authenticated (EML-03)');
  const when = at ? new Date(at).toISOString() : issue.planned_send_at;
  const ch = channelBySlug('email');
  const utm = `newsletter_${when.slice(0, 7).replace('-', '_')}_${issue.language}`;
  let camp = one('SELECT id FROM campaigns WHERE utm_campaign = ?', utm);
  if (!camp) camp = { id: Number(run('INSERT INTO campaigns (channel_id, name, utm_campaign, start_date, is_recruitment, created_at) VALUES (?,?,?,?,0,?)', ch.id, `Newsletter ${when.slice(0, 7)} ${issue.language.toUpperCase()}`, utm, when.slice(0, 10), now()).lastInsertRowid) };
  return tx(() => {
    const slug = issue.archive_slug || `${when.slice(0, 7)}-${issue.language}-${randomId(4)}`;
    const send = createSend({ kind: 'newsletter', name: issue.title, campaign_id: camp.id, segment_id: issue.segment_id || newsletterSegment(issue.language), domain_id: domain.id, subject: issue.subject, preheader: issue.preheader, body: issueToEmailBlocks(issue), language: issue.language, topic: 'newsletter', exclude_active_applicants: false }, actor);
    run(`UPDATE sends SET status = 'scheduled', approved_by = ?, approved_at = ?, scheduled_at = ? WHERE id = ?`, issue.approved_by, issue.approved_at, when, send.id);
    run(`UPDATE issues SET status = 'scheduled', send_id = ?, archive_slug = ?, segment_id = COALESCE(segment_id, ?), updated_at = ? WHERE id = ?`, send.id, slug, send.segment_id, now(), id);
    audit(actor, 'newsletter.schedule', { entity: 'issue', entityId: id, meta: { at: when, sendId: send.id } });
    return getIssue(id);
  });
}
export function unscheduleIssue(id, actor) {
  const issue = getIssue(id);
  if (issue?.status !== 'scheduled') throw bad('Issue is not scheduled');
  const s = getSend(issue.send_id);
  if (s && s.status === 'sending') throw bad('Sending has already started');
  run(`UPDATE sends SET status = 'cancelled' WHERE id = ?`, issue.send_id);
  run(`UPDATE issues SET status = 'approved', send_id = NULL, updated_at = ? WHERE id = ?`, now(), id);
  audit(actor, 'newsletter.unschedule', { entity: 'issue', entityId: id });
  return getIssue(id);
}

export function issueReport(id) {
  const issue = getIssue(id);
  if (!issue?.send_id) throw bad('This issue has not been sent');
  const r = sendReport(issue.send_id);
  const blockNames = Object.fromEntries(issue.blocks.map((b) => [`b${b.id}`, b.title || b.type]));
  r.blocks = r.blocks.map((b) => ({ ...b, name: blockNames[b.block_id] || b.block_id || 'footer / other' }));
  return r;
}

export function archivedIssue(slug) {
  const i = one(`SELECT id FROM issues WHERE archive_slug = ? AND status IN ('scheduled','sent')`, slug);
  if (!i) return null;
  const issue = getIssue(i.id);
  if (issue.status === 'scheduled' && new Date(issue.planned_send_at) > new Date()) return null; // not public before it is sent
  return issue;
}
export function archiveList() {
  return q(`SELECT title, language, archive_slug, planned_send_at FROM issues WHERE status = 'sent' AND archive_slug IS NOT NULL ORDER BY planned_send_at DESC`);
}

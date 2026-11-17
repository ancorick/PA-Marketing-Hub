// Analytics data pipeline (9.1, 9.2, ANL-01..03, ANL-11).
// Extract, load, then transform: every pull lands unchanged in raw_records with
// its pull time; transforms upsert by source id, so any window can be re-run
// or replayed from raw without double counting.
import { q, one, run, now, json, parse, tx } from '../../db.js';
import { isoDate, addDays } from '../../lib/util.js';
import { audit, getSetting, raiseAlert } from '../../lib/core.js';
import { mapUtm, campaignByUtm, channelBySlug, addCost } from './taxonomy.js';
import { upsertContact, findByEmail } from '../audience.js';
import { computeAttribution } from './attribution.js';

const PAGE = 500;
const EPOCH = '2024-01-01T00:00:00.000Z';

export function recordTouchpoint(t) {
  const channelId = t.channelId ?? mapUtm(t.utm_source, t.utm_medium, t.sourceSystem);
  const camp = t.campaignId ? { id: t.campaignId } : campaignByUtm(t.utm_campaign, channelId, { at: t.at });
  const r = run(
    `INSERT INTO touchpoints (contact_id, campaign_id, channel_id, type, occurred_at, source_system, source_ref, utm_source, utm_medium, utm_campaign)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source_system, source_ref) DO UPDATE SET contact_id = excluded.contact_id, channel_id = excluded.channel_id, campaign_id = excluded.campaign_id, occurred_at = excluded.occurred_at`,
    t.contactId ?? null, camp?.id ?? null, channelId, t.type, t.at, t.sourceSystem, t.sourceRef, t.utm_source ?? null, t.utm_medium ?? null, t.utm_campaign ?? null,
  );
  return { changes: r.changes, channelId };
}

export function recordOutcome(o) {
  return run(
    `INSERT INTO outcomes (contact_id, core_person_id, type, occurred_at, course_id, source_system, source_ref, self_reported_channel_id)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(source_system, source_ref) DO UPDATE SET contact_id = excluded.contact_id, occurred_at = excluded.occurred_at, course_id = excluded.course_id,
       self_reported_channel_id = COALESCE(excluded.self_reported_channel_id, outcomes.self_reported_channel_id)`,
    o.contactId ?? null, o.corePersonId ?? null, o.type, o.at, o.course ?? null, o.sourceSystem, o.sourceRef, o.selfReportedChannelId ?? null,
  ).changes;
}

const STAGE_TYPE = { lead: 'lead', applied: 'applicant', interview: 'applicant', accepted: 'applicant', rejected: 'lead', dropped: 'lead', enrolled: 'student' };

// ---------- Adapters: one interface (pull window, map, load) per source (11.3) ----------
export const ADAPTERS = {
  website: {
    label: 'Website analytics (GA4 Data API)', kind: 'external', frequency: 'daily',
    pull: (w) => ({
      sessions: q('SELECT * FROM ext_web_sessions WHERE date >= ? AND date <= ?', isoDate(w.from), isoDate(w.to)),
      identified: q('SELECT * FROM ext_web_identified WHERE occurred_at >= ? AND occurred_at <= ?', w.from, w.to),
    }),
    transform: (page) => {
      let n = 0;
      for (const s of page.sessions || []) {
        const ch = mapUtm(s.utm_source, s.utm_medium, 'website');
        n += run(`INSERT INTO web_traffic (date, channel_id, utm_campaign, sessions, conversions, source_ref) VALUES (?,?,?,?,?,?)
                  ON CONFLICT(source_ref) DO UPDATE SET sessions = excluded.sessions, conversions = excluded.conversions, channel_id = excluded.channel_id`,
          s.date, ch, s.utm_campaign, s.sessions, s.conversions, `ga4:${s.id}`).changes;
      }
      // Identified hits (signed contact token or email on a form) become individual touchpoints;
      // anonymous sessions count toward channel traffic only.
      for (const h of page.identified || []) {
        const c = findByEmail(h.email);
        if (!c) continue;
        n += recordTouchpoint({ contactId: c.id, type: h.type, at: h.occurred_at, sourceSystem: 'website', sourceRef: h.id, utm_source: h.utm_source, utm_medium: h.utm_medium, utm_campaign: h.utm_campaign }).changes;
      }
      return n;
    },
  },
  social: {
    label: 'Social platforms (Meta Graph API)', kind: 'external', frequency: 'daily',
    pull: (w) => ({ posts: q('SELECT * FROM ext_social_posts WHERE date >= ? AND date <= ?', isoDate(w.from), isoDate(w.to)) }),
    transform: (page) => {
      let n = 0;
      for (const p of page.posts || []) {
        n += run(`INSERT INTO social_stats (date, platform, reach, engagement, followers, lead_forms, source_ref) VALUES (?,?,?,?,?,?,?)
                  ON CONFLICT(source_ref) DO UPDATE SET reach = excluded.reach, engagement = excluded.engagement, followers = excluded.followers, lead_forms = excluded.lead_forms`,
          p.date, p.platform, p.reach, p.engagement, p.followers, p.lead_forms, `meta:${p.id}`).changes;
      }
      return n;
    },
  },
  meta_ads: {
    label: 'Meta Ads (Marketing API)', kind: 'external', frequency: 'daily',
    pull: (w) => ({ spend: q(`SELECT * FROM ext_ad_spend WHERE platform = 'meta' AND date >= ? AND date <= ?`, isoDate(w.from), isoDate(w.to)) }),
    transform: (page) => loadAdSpend(page.spend, 'meta_ads', 'paid_social'),
  },
  google_ads: {
    label: 'Google Ads API', kind: 'external', frequency: 'daily',
    pull: (w) => ({ spend: q(`SELECT * FROM ext_ad_spend WHERE platform = 'google' AND date >= ? AND date <= ?`, isoDate(w.from), isoDate(w.to)) }),
    transform: (page) => loadAdSpend(page.spend, 'google_ads', 'paid_search'),
  },
  crm: {
    label: 'Navigator CRM (Project 2)', kind: 'internal', frequency: 'real time',
    pull: (w) => ({ leads: q('SELECT * FROM ext_crm_leads WHERE updated_at >= ? AND updated_at <= ?', w.from, w.to) }),
    transform: (page) => {
      let n = 0;
      for (const l of page.leads || []) {
        const channelId = mapUtm(l.utm_source, l.utm_medium, 'crm');
        const camp = campaignByUtm(l.utm_campaign, channelId, { at: l.created_at });
        const { contact } = upsertContact(
          { email: l.email, first_name: l.first_name, last_name: l.last_name, phone: l.phone, language: l.language, course_family: l.course_family, type: STAGE_TYPE[l.stage] || 'lead', core_person_id: l.person_id || undefined },
          { channelId, campaignId: camp?.id, firstTouchAt: l.created_at, createdAt: l.created_at, method: 'sync', consent: l.opt_in ? { courses: 'granted' } : {}, consentAt: l.created_at },
        );
        // Mirror the CRM stage (applicant -> back to lead when rejected or dropped).
        if (['lead', 'applicant'].includes(contact.type) || contact.type === 'subscriber') {
          const t = STAGE_TYPE[l.stage] || 'lead';
          if (t !== 'student') run('UPDATE contacts SET type = ? WHERE id = ?', t, contact.id);
        }
        n += recordTouchpoint({ contactId: contact.id, channelId, campaignId: camp?.id, type: l.utm_source === 'chatbot' ? 'chat' : l.utm_source === 'referral' ? 'referral' : 'lead', at: l.created_at, sourceSystem: 'crm', sourceRef: `lead:${l.lead_id}`, utm_source: l.utm_source, utm_medium: l.utm_medium, utm_campaign: l.utm_campaign }).changes;
        const self = l.self_reported_source ? channelBySlug(l.self_reported_source) : null;
        n += recordOutcome({ contactId: contact.id, corePersonId: l.person_id, type: 'lead', at: l.created_at, course: l.course_family, sourceSystem: 'crm', sourceRef: `lead:${l.lead_id}`, selfReportedChannelId: self?.id });
        if (l.applied_at) n += recordOutcome({ contactId: contact.id, corePersonId: l.person_id, type: 'applied', at: l.applied_at, course: l.course_family, sourceSystem: 'crm', sourceRef: `applied:${l.lead_id}`, selfReportedChannelId: self?.id });
      }
      return n;
    },
  },
  core: {
    label: 'Academy Core Engine (Project 1)', kind: 'internal', frequency: 'real time',
    pull: (w) => ({ people: q('SELECT * FROM ext_core_people WHERE updated_at >= ? AND updated_at <= ?', w.from, w.to) }),
    transform: (page) => {
      let n = 0;
      for (const p of page.people || []) {
        const type = p.status === 'alumnus' ? 'alumnus' : p.status === 'student' ? 'student' : undefined;
        const { contact } = upsertContact({ email: p.email, first_name: p.first_name, last_name: p.last_name, phone: p.phone, language: p.language, course_family: p.course_family, core_person_id: p.person_id, type }, { method: 'sync' });
        if (type) run('UPDATE contacts SET type = ?, course_family = COALESCE(course_family, ?) WHERE id = ?', type, p.course_family, contact.id);
        if (p.enrolled_at) n += recordOutcome({ contactId: contact.id, corePersonId: p.person_id, type: 'enrolled', at: p.enrolled_at, course: p.course, sourceSystem: 'core', sourceRef: `enrolled:${p.person_id}:${p.group_code}` });
        if (p.graduated_at && p.completed) n += recordOutcome({ contactId: contact.id, corePersonId: p.person_id, type: 'completed', at: p.graduated_at, course: p.course, sourceSystem: 'core', sourceRef: `completed:${p.person_id}:${p.group_code}` });
      }
      return n;
    },
  },
  alumni: {
    label: 'Alumni Tracker (Project 11)', kind: 'internal', frequency: 'daily',
    pull: (w) => ({ alumni: q('SELECT * FROM ext_alumni WHERE updated_at >= ? AND updated_at <= ?', w.from, w.to) }),
    transform: (page) => {
      let n = 0;
      for (const a of page.alumni || []) {
        const c = one('SELECT id FROM contacts WHERE core_person_id = ?', a.person_id);
        if (!c) continue;
        run('UPDATE contacts SET employment_status = ?, referred_enrolled = ? WHERE id = ?', a.status, a.referred_enrolled || 0, c.id);
        if (a.status === 'employed' && a.start_date) n += recordOutcome({ contactId: c.id, corePersonId: a.person_id, type: 'hired', at: a.start_date, sourceSystem: 'alumni', sourceRef: `hired:${a.person_id}` });
      }
      return n;
    },
  },
};

// Real-time sources with no pull: health comes from their webhook stream.
export const STREAMS = {
  esp: { label: 'Email service provider (webhooks)', kind: 'stream', frequency: 'real time' },
  event_hub: { label: 'Event Hub (Project 13, webhooks)', kind: 'stream', frequency: 'real time' },
};

function loadAdSpend(rows, source, defaultChannel) {
  let n = 0;
  const fallback = channelBySlug(defaultChannel);
  for (const r of rows || []) {
    const camp = campaignByUtm(r.utm_campaign, fallback.id, { at: r.date });
    addCost({ channel_id: camp?.channel_id || fallback.id, campaign_id: camp?.id, date_from: r.date, date_to: r.date, amount: r.spend, currency: r.currency, note: `${r.impressions} impressions, ${r.clicks} clicks` },
      null, { source: 'api', sourceRef: `${source}:${r.id}` });
    n++;
  }
  return n;
}

function lastSuccess(source) {
  return one(`SELECT * FROM sync_runs WHERE source = ? AND status = 'success' ORDER BY id DESC LIMIT 1`, source);
}

export async function runSource(source, window = {}, actor) {
  const a = ADAPTERS[source];
  if (!a) throw new Error(`Unknown source ${source}`);
  const last = lastSuccess(source);
  // Overlapping window: re-pull the last 2 days so late updates are caught.
  const from = window.from || (last ? addDays(last.window_to, -2).toISOString() : EPOCH);
  const to = window.to || now();
  const runId = Number(run('INSERT INTO sync_runs (source, started_at, status, window_from, window_to) VALUES (?,?,?,?,?)', source, now(), 'running', from, to).lastInsertRowid);
  try {
    if (getSetting('simulate_failure')?.[source]) throw new Error('Simulated API error: 503 Service Unavailable');
    const pulled = a.pull({ from, to });
    let rowsIn = 0; let upserted = 0;
    tx(() => {
      for (const [endpoint, items] of Object.entries(pulled)) {
        for (let i = 0; i < items.length; i += PAGE) {
          const pageItems = items.slice(i, i + PAGE);
          run('INSERT INTO raw_records (source, endpoint, window_from, window_to, payload, pulled_at) VALUES (?,?,?,?,?,?)', source, endpoint, from, to, json(pageItems), now());
          rowsIn += pageItems.length;
          upserted += a.transform({ [endpoint]: pageItems });
        }
      }
    });
    run(`UPDATE sync_runs SET status = 'success', finished_at = ?, rows_in = ?, rows_upserted = ? WHERE id = ?`, now(), rowsIn, upserted, runId);
    return { source, status: 'success', rowsIn, upserted };
  } catch (e) {
    run(`UPDATE sync_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`, now(), String(e.message).slice(0, 500), runId);
    const recent = q('SELECT status FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 2', source);
    if (recent.length === 2 && recent.every((r) => r.status === 'failed')) {
      raiseAlert('critical', 'source_failed', `${a.label} failed twice in a row: ${e.message}`, { source });
    }
    return { source, status: 'failed', error: e.message };
  } finally {
    if (actor) audit(actor, 'pipeline.run', { meta: { source } });
  }
}

export async function runAll(actor, { attribution = true } = {}) {
  const results = [];
  // Internal identity sources first, so marketing touches can be matched to contacts.
  for (const s of ['crm', 'core', 'alumni', 'website', 'social', 'meta_ads', 'google_ads']) results.push(await runSource(s, {}, actor));
  if (attribution) computeAttribution();
  return results;
}

// Rebuild clean tables from raw responses (after a taxonomy or logic change).
export function replay(source, actor) {
  const a = ADAPTERS[source];
  if (!a) throw new Error(`Unknown source ${source}`);
  let n = 0;
  tx(() => { for (const r of q('SELECT endpoint, payload FROM raw_records WHERE source = ? ORDER BY id', source)) n += a.transform({ [r.endpoint]: parse(r.payload, []) }); });
  computeAttribution();
  audit(actor, 'pipeline.replay', { meta: { source, rows: n } });
  return { source, replayed: n };
}

// Raw data is kept 13 months (12.4).
export function enforceRetention() {
  const cutoff = new Date(Date.now() - 395 * 864e5).toISOString();
  return run('DELETE FROM raw_records WHERE pulled_at < ?', cutoff).changes;
}

export function dataHealth() {
  const sources = [];
  for (const [key, a] of Object.entries(ADAPTERS)) {
    const runs = q('SELECT * FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 5', key);
    const ok = lastSuccess(key);
    const consecutiveFailures = (() => { let n = 0; for (const r of runs) { if (r.status === 'failed') n++; else break; } return n; })();
    const ageH = ok ? (Date.now() - new Date(ok.finished_at)) / 36e5 : null;
    const target = a.kind === 'internal' ? 1 : 24;
    sources.push({
      key, label: a.label, kind: a.kind, frequency: a.frequency,
      last_success: ok?.finished_at || null, last_run: runs[0] || null, consecutive_failures: consecutiveFailures,
      rows_last: ok?.rows_in ?? null, freshness_hours: ageH == null ? null : Math.round(ageH * 10) / 10, target_hours: target,
      fresh: ageH != null && ageH <= target, simulate_failure: !!getSetting('simulate_failure')?.[key],
      raw_records: one('SELECT COUNT(*) n FROM raw_records WHERE source = ?', key).n,
    });
  }
  for (const [key, s] of Object.entries(STREAMS)) {
    const last = one('SELECT MAX(received_at) at, COUNT(*) n, SUM(error IS NOT NULL) errors FROM webhook_events WHERE source = ?', key);
    const ageH = last?.at ? (Date.now() - new Date(last.at)) / 36e5 : null;
    sources.push({ key, label: s.label, kind: s.kind, frequency: s.frequency, last_success: last?.at || null, rows_last: last?.n || 0, errors: last?.errors || 0, freshness_hours: ageH == null ? null : Math.round(ageH * 10) / 10, target_hours: 1, fresh: ageH != null && ageH <= 24 });
  }
  const unmapped = q(`SELECT u.*, ch.name resolved_name FROM unmapped_values u LEFT JOIN channels ch ON ch.id = u.resolved_channel_id ORDER BY u.resolved_channel_id IS NOT NULL, u.count DESC`);
  const unattributed = one(`SELECT COUNT(*) n FROM touchpoints WHERE channel_id IS NULL`).n;
  return { sources, unmapped, unmatched_touchpoints: unattributed };
}

// Fallback for ad platforms without API access yet (R1): CSV upload of an ads report.
export function importAdCsv(rows, platform, actor) {
  let n = 0;
  tx(() => {
    for (const r of rows) {
      const id = `csv:${platform}:${r.date}:${r.utm_campaign}`;
      run(`INSERT OR REPLACE INTO ext_ad_spend (id, date, platform, utm_campaign, spend, currency, impressions, clicks, leads) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, isoDate(r.date), platform, r.utm_campaign, Number(r.spend), (r.currency || 'AMD').toUpperCase(), Number(r.impressions || 0), Number(r.clicks || 0), Number(r.leads || 0));
      n++;
    }
  });
  audit(actor, 'ads.csv_import', { meta: { platform, rows: n } });
  return n;
}

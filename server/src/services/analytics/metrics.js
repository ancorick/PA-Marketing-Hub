// Metric definitions and dashboard views (9.5, 9.6, ANL-08..10, ANL-14).
import { q, one } from '../../db.js';
import { getSetting } from '../../lib/core.js';
import { bad, notFound, monthOf } from '../../lib/util.js';
import { costInRange, listChannels } from './taxonomy.js';
import { MODELS, selfReportedAgreement } from './attribution.js';

export const DEFINITIONS = {
  lead: 'A contact who first expressed interest in a course in the period (CRM stage lead or later).',
  applied: 'A lead who submitted an application.',
  enrolled: 'An applicant whose record became an active student in the Core Engine.',
  completed: 'An enrolled student who finished the course (graduated).',
  hired: 'A graduate with employment status employed in Alumni Tracker, in a role reported by the graduate.',
  spend: 'Ad spend plus manual costs allocated to the channel in the period, in AMD (prorated by days).',
  cost_per_lead: 'Channel cost in the period divided by leads credited to the channel.',
  cost_per_enrolled: 'Channel cost in the period divided by enrolled students credited to the channel.',
  cost_per_hired: 'Channel cost of a cohort divided by hired graduates from that cohort. Shown as final only for cohorts at least 12 months old.',
  time_to_hire: 'Days from graduation to job start date.',
  open_rate: 'Estimated: some mail clients load images automatically (inflating opens), others block them.',
  click_rate: 'Unique clickers divided by delivered messages.',
};

const OUTCOME_TYPES = ['lead', 'applied', 'enrolled', 'completed', 'hired'];

export function parseRange({ from, to }) {
  const t = to ? new Date(to) : new Date();
  const f = from ? new Date(from) : new Date(t.getTime() - 90 * 864e5);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f > t) throw bad('Invalid date range');
  return { from: f.toISOString().slice(0, 10), to: t.toISOString().slice(0, 10) };
}
const end = (d) => `${d}T23:59:59.999Z`;
const checkModel = (m) => { if (!MODELS.includes(m)) throw bad(`Unknown attribution model ${m}`); return m; };
const ratio = (cost, n) => (n > 0 ? Math.round(cost / n) : null);

// Credited outcomes by channel (period view: outcomes that happened in the range).
function creditedByChannel({ from, to, model, campaignChannel, cohort = false }) {
  const where = cohort ? 'ar.cohort_month >= ? AND ar.cohort_month <= ?' : 'o.occurred_at >= ? AND o.occurred_at <= ?';
  const params = cohort ? [from.slice(0, 7), to.slice(0, 7)] : [from, end(to)];
  const group = campaignChannel ? 'ar.campaign_id' : 'ar.channel_id';
  const rows = q(`SELECT ${group} k, o.type, SUM(ar.credit) credit FROM attribution_results ar JOIN outcomes o ON o.id = ar.outcome_id
                  WHERE ar.model = ? AND ${where} ${campaignChannel ? 'AND ar.channel_id = ?' : ''} GROUP BY ${group}, o.type`,
  model, ...params, ...(campaignChannel ? [campaignChannel] : []));
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.k)) map.set(r.k, Object.fromEntries(OUTCOME_TYPES.map((t) => [t, 0])));
    map.get(r.k)[r.type] = r.credit;
  }
  return map;
}
const round1 = (x) => Math.round(x * 10) / 10;

export function overview({ from, to, model = 'first_touch', view = 'period' }) {
  const r = parseRange({ from, to }); checkModel(model);
  const cohort = view === 'cohort';
  const credited = creditedByChannel({ ...r, model, cohort });
  const maturityMonths = getSetting('cohort_maturity_months');
  const matureCutoff = new Date(); matureCutoff.setMonth(matureCutoff.getMonth() - maturityMonths);
  const maturing = cohort && new Date(r.to) > matureCutoff;
  const channels = listChannels().map((ch) => {
    const c = credited.get(ch.id) || {};
    const spend = costInRange({ ...r, channelId: ch.id });
    const row = {
      channel_id: ch.id, slug: ch.slug, channel: ch.name, group: ch.grp,
      leads: round1(c.lead || 0), applied: round1(c.applied || 0), enrolled: round1(c.enrolled || 0), completed: round1(c.completed || 0), hired: round1(c.hired || 0),
      spend, cost_per_lead: ratio(spend, c.lead), cost_per_enrolled: ratio(spend, c.enrolled),
    };
    if (cohort) { row.cost_per_hired = ratio(spend, c.hired); row.maturing = maturing; }
    return row;
  });
  const un = credited.get(null);
  const unattributed = un ? { leads: round1(un.lead || 0), enrolled: round1(un.enrolled || 0), hired: round1(un.hired || 0) } : { leads: 0, enrolled: 0, hired: 0 };
  const totals = channels.reduce((a, c) => { for (const k of ['leads', 'applied', 'enrolled', 'completed', 'hired', 'spend']) a[k] = (a[k] || 0) + c[k]; return a; }, {});
  totals.leads += unattributed.leads; totals.enrolled += unattributed.enrolled; totals.hired += unattributed.hired;
  for (const k of ['leads', 'applied', 'enrolled', 'completed', 'hired']) totals[k] = round1(totals[k]);
  totals.cost_per_enrolled = ratio(totals.spend, totals.enrolled);
  totals.cost_per_lead = ratio(totals.spend, totals.leads);

  // Headline tiles.
  const subscribers = one(`SELECT COUNT(*) n FROM contacts c WHERE c.status = 'active' AND c.merged_into IS NULL
     AND (SELECT state FROM consent_records cr WHERE cr.contact_id = c.id AND cr.topic = 'newsletter' ORDER BY cr.id DESC LIMIT 1) = 'granted'`).n;
  const nl = one(`SELECT SUM(d.status IN ('delivered','complained')) delivered, SUM(d.first_click_at IS NOT NULL) clicked, SUM(d.opened_at IS NOT NULL) opened
     FROM deliveries d WHERE d.send_id IN (SELECT id FROM sends WHERE kind = 'newsletter' AND status = 'sent' ORDER BY started_at DESC LIMIT 3)`);
  const newLeads = one(`SELECT COUNT(DISTINCT contact_id) n FROM outcomes WHERE type = 'lead' AND occurred_at >= ? AND occurred_at <= ?`, r.from, end(r.to)).n;
  const enrolledFromThem = one(`SELECT COUNT(DISTINCT o2.contact_id) n FROM outcomes o1 JOIN outcomes o2 ON o2.contact_id = o1.contact_id AND o2.type = 'enrolled'
     WHERE o1.type = 'lead' AND o1.occurred_at >= ? AND o1.occurred_at <= ?`, r.from, end(r.to)).n;
  // Attributed enrollment coverage (M1).
  const cov = one(`SELECT COUNT(*) total, SUM(ar.channel_id IS NOT NULL) known FROM outcomes o JOIN attribution_results ar ON ar.outcome_id = o.id AND ar.model = 'first_touch'
     WHERE o.type = 'enrolled' AND o.occurred_at >= ? AND o.occurred_at <= ?`, r.from, end(r.to));
  return {
    range: r, model, view, maturing, definitions: DEFINITIONS,
    tiles: {
      subscribers,
      newsletter_click_rate: nl?.delivered ? nl.clicked / nl.delivered : null,
      newsletter_open_rate_estimated: nl?.delivered ? nl.opened / nl.delivered : null,
      new_leads: newLeads, enrolled_from_new_leads: enrolledFromThem,
    },
    channels: channels.sort((a, b) => b.enrolled - a.enrolled || b.leads - a.leads),
    unattributed, totals,
    coverage: { enrolled: cov.total || 0, attributed: cov.known || 0, rate: cov.total ? (cov.known || 0) / cov.total : null },
    self_reported: selfReportedAgreement({ from: r.from, to: end(r.to) }),
  };
}

export function channelDetail(channelId, { from, to, model = 'first_touch' }) {
  const ch = one('SELECT * FROM channels WHERE id = ?', channelId);
  if (!ch) throw notFound('Channel not found');
  const r = parseRange({ from, to }); checkModel(model);
  const credited = creditedByChannel({ ...r, model }).get(ch.id) || {};
  const funnel = OUTCOME_TYPES.map((t) => ({ stage: t, value: round1(credited[t] || 0) }));
  const byCampaign = creditedByChannel({ ...r, model, campaignChannel: ch.id });
  const campaigns = q('SELECT * FROM campaigns WHERE channel_id = ? ORDER BY start_date DESC', ch.id).map((ca) => {
    const c = byCampaign.get(ca.id) || {};
    const spend = costInRange({ ...r, campaignId: ca.id });
    return { id: ca.id, name: ca.name, utm_campaign: ca.utm_campaign, spend, leads: round1(c.lead || 0), applied: round1(c.applied || 0), enrolled: round1(c.enrolled || 0), hired: round1(c.hired || 0), cost_per_lead: ratio(spend, c.lead), cost_per_enrolled: ratio(spend, c.enrolled) };
  }).filter((c) => c.spend || c.leads || c.enrolled);
  // 12-month trend.
  const months = [];
  const d = new Date(); d.setUTCDate(1);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const mFrom = m.toISOString().slice(0, 10);
    const mTo = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const c = creditedByChannel({ from: mFrom, to: mTo, model }).get(ch.id) || {};
    months.push({ month: mFrom.slice(0, 7), leads: round1(c.lead || 0), enrolled: round1(c.enrolled || 0), spend: costInRange({ from: mFrom, to: mTo, channelId: ch.id }) });
  }
  const spend = costInRange({ ...r, channelId: ch.id });
  return { channel: ch, range: r, model, funnel, spend, cost_per_lead: ratio(spend, credited.lead), cost_per_enrolled: ratio(spend, credited.enrolled), campaigns, trend: months };
}

export function campaignDetail(campaignId, { from, to, model = 'first_touch' }) {
  const ca = one(`SELECT ca.*, ch.name channel_name FROM campaigns ca JOIN channels ch ON ch.id = ca.channel_id WHERE ca.id = ?`, campaignId);
  if (!ca) throw notFound('Campaign not found');
  const r = parseRange({ from: from || ca.start_date || undefined, to }); checkModel(model);
  const c = creditedByChannel({ ...r, model, campaignChannel: ca.channel_id }).get(ca.id) || {};
  const spend = costInRange({ ...r, campaignId: ca.id });
  return {
    campaign: ca, range: r, model, spend,
    funnel: OUTCOME_TYPES.map((t) => ({ stage: t, value: round1(c[t] || 0) })),
    cost_per_lead: ratio(spend, c.lead), cost_per_applied: ratio(spend, c.applied), cost_per_enrolled: ratio(spend, c.enrolled), cost_per_hired: ratio(spend, c.hired),
    links: q('SELECT code, url, hits FROM short_links WHERE campaign_id = ?', ca.id),
  };
}

// Cohort view (9.5): outcomes grouped by month of first touch; cost of that month.
export function cohorts({ months = 18, channelId, model = 'first_touch' }) {
  checkModel(model);
  const maturity = getSetting('cohort_maturity_months');
  const rows = [];
  const d = new Date(); d.setUTCDate(1);
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const key = m.toISOString().slice(0, 7);
    const mFrom = `${key}-01`;
    const mTo = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const c = Object.fromEntries(q(`SELECT o.type, SUM(ar.credit) credit FROM attribution_results ar JOIN outcomes o ON o.id = ar.outcome_id
       WHERE ar.model = ? AND ar.cohort_month = ? ${channelId ? 'AND ar.channel_id = ?' : ''} GROUP BY o.type`, model, key, ...(channelId ? [channelId] : [])).map((x) => [x.type, x.credit]));
    const spend = costInRange({ from: mFrom, to: mTo, channelId: channelId || undefined });
    const ageMonths = (d.getUTCFullYear() - m.getUTCFullYear()) * 12 + (d.getUTCMonth() - m.getUTCMonth());
    rows.push({
      cohort: key, age_months: ageMonths, maturing: ageMonths < maturity,
      leads: round1(c.lead || 0), applied: round1(c.applied || 0), enrolled: round1(c.enrolled || 0), completed: round1(c.completed || 0), hired: round1(c.hired || 0),
      spend, cost_per_enrolled: ratio(spend, c.enrolled), cost_per_hired: ratio(spend, c.hired),
    });
  }
  return { model, channel_id: channelId || null, maturity_months: maturity, rows: rows.reverse() };
}

export function audienceStats() {
  const growth = q(`SELECT substr(created_at,1,7) month, COUNT(*) n FROM contacts WHERE merged_into IS NULL GROUP BY month ORDER BY month DESC LIMIT 18`).reverse();
  const consent = one(`SELECT COUNT(*) total,
      SUM((SELECT state FROM consent_records cr WHERE cr.contact_id = c.id AND cr.topic = 'newsletter' ORDER BY cr.id DESC LIMIT 1) IS NOT NULL) recorded,
      SUM((SELECT state FROM consent_records cr WHERE cr.contact_id = c.id AND cr.topic = 'newsletter' ORDER BY cr.id DESC LIMIT 1) = 'granted') granted,
      SUM((SELECT state FROM consent_records cr WHERE cr.contact_id = c.id AND cr.topic = 'newsletter' ORDER BY cr.id DESC LIMIT 1) = 'unknown') unknown
     FROM contacts c WHERE c.merged_into IS NULL AND c.status != 'erased'`);
  // M4: contacts who received marketing email in the last 90 days must all have a consent record.
  const recipients = one(`SELECT COUNT(DISTINCT d.contact_id) n, SUM(NOT EXISTS (SELECT 1 FROM consent_records cr WHERE cr.contact_id = d.contact_id)) missing
     FROM deliveries d WHERE d.queued_at >= ?`, new Date(Date.now() - 90 * 864e5).toISOString());
  const unsubs = q(`SELECT substr(recorded_at,1,7) month, SUM(reason='unsubscribed') unsubscribed, SUM(reason IN ('hard_bounce','soft_bounce')) bounced, SUM(reason='complaint') complaints
     FROM suppression GROUP BY month ORDER BY month DESC LIMIT 12`).reverse();
  const byType = q(`SELECT type, COUNT(*) n FROM contacts WHERE merged_into IS NULL AND status != 'erased' GROUP BY type`);
  const byLang = q(`SELECT language, COUNT(*) n FROM contacts WHERE merged_into IS NULL AND status != 'erased' GROUP BY language`);
  const total = one(`SELECT COUNT(*) n FROM contacts WHERE merged_into IS NULL AND status != 'erased'`).n;
  const dupeGroups = one(`SELECT COUNT(*) n FROM (SELECT email_cmp FROM contacts WHERE merged_into IS NULL AND status != 'erased' AND email_cmp IS NOT NULL GROUP BY email_cmp HAVING COUNT(*) > 1)`).n;
  return {
    total, growth, byType, byLang, unsubs,
    consent: { ...consent, coverage: consent.total ? consent.recorded / consent.total : null },
    m4_recipients_with_consent: recipients.n ? (recipients.n - (recipients.missing || 0)) / recipients.n : null,
    m3_duplicate_rate: total ? dupeGroups / total : 0,
    segments: q('SELECT id, name, type, last_count FROM segments ORDER BY last_count DESC'),
  };
}

export function eventsView({ from, to, model = 'first_touch' }) {
  const r = parseRange({ from: from || '2024-01-01', to }); checkModel(model);
  return q(`SELECT e.* FROM events e WHERE e.starts_at >= ? AND e.starts_at <= ? ORDER BY e.starts_at DESC`, r.from, end(r.to)).map((e) => {
    const reg = one(`SELECT COUNT(*) n, SUM(checked_in_at IS NOT NULL) att, SUM(cancelled_at IS NOT NULL) cancelled FROM event_registrations WHERE event_id = ?`, e.id);
    const credited = e.campaign_id ? Object.fromEntries(q(`SELECT o.type, SUM(ar.credit) c FROM attribution_results ar JOIN outcomes o ON o.id = ar.outcome_id WHERE ar.model = ? AND ar.campaign_id = ? GROUP BY o.type`, model, e.campaign_id).map((x) => [x.type, x.c])) : {};
    const cost = e.campaign_id ? one(`SELECT COALESCE(SUM(amount_amd),0) n FROM costs WHERE campaign_id = ?`, e.campaign_id).n : 0;
    return {
      id: e.id, title: e.title, type: e.type, starts_at: e.starts_at, source: e.source, cost: Math.round(cost),
      registrations: reg.n || 0, attendees: reg.att || 0, cancelled: reg.cancelled || 0,
      leads: round1(credited.lead || 0), enrolled: round1(credited.enrolled || 0), hired: round1(credited.hired || 0),
      cost_per_enrolled: ratio(cost, credited.enrolled),
    };
  });
}

export function newsletterTrends() {
  return q(`SELECT s.id, s.name, s.started_at, s.language FROM sends s WHERE s.kind = 'newsletter' AND s.started_at IS NOT NULL ORDER BY s.started_at DESC LIMIT 12`).map((s) => {
    const st = one(`SELECT SUM(status IN ('delivered','complained')) delivered, SUM(first_click_at IS NOT NULL) clicked, SUM(opened_at IS NOT NULL) opened, SUM(unsubscribed_at IS NOT NULL) unsub FROM deliveries WHERE send_id = ?`, s.id);
    return { ...s, delivered: st.delivered || 0, click_rate: st.delivered ? st.clicked / st.delivered : null, open_rate_estimated: st.delivered ? st.opened / st.delivered : null, unsubscribe_rate: st.delivered ? st.unsub / st.delivered : null };
  }).reverse();
}

// ---------- Small-number suppression (ANL-14, NFR-P5) ----------
const COUNT_KEYS = new Set(['leads', 'applied', 'enrolled', 'completed', 'hired', 'registrations', 'attendees', 'value', 'new_leads', 'enrolled_from_new_leads']);
const RATIO_OF = { cost_per_lead: 'leads', cost_per_enrolled: 'enrolled', cost_per_hired: 'hired', cost_per_applied: 'applied' };
export function suppressSmall(data, threshold = getSetting('small_number_threshold')) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      for (const [k, x] of Object.entries(v)) {
        if (COUNT_KEYS.has(k) && typeof x === 'number' && x > 0 && x < threshold) o[k] = `fewer than ${threshold}`;
        if (RATIO_OF[k] && typeof v[RATIO_OF[k]] === 'number' && v[RATIO_OF[k]] > 0 && v[RATIO_OF[k]] < threshold) o[k] = null;
      }
      return o;
    }
    return v;
  };
  return walk(data);
}

export { monthOf };

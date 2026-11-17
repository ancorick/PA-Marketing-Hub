// Channel taxonomy, campaigns, link builder, FX and costs (9.2, 9.3, ANL-03..05).
import { q, one, run, now, tx } from '../../db.js';
import { bad, notFound, randomId, isoDate } from '../../lib/util.js';
import { audit } from '../../lib/core.js';
import { config } from '../../config.js';

export const DEFAULT_CHANNELS = [
  { slug: 'paid_social', name: 'Paid social', grp: 'paid', utm_source: 'instagram', utm_medium: 'paid_social' },
  { slug: 'organic_social', name: 'Organic social', grp: 'organic', utm_source: 'instagram', utm_medium: 'social' },
  { slug: 'search_website', name: 'Search and website', grp: 'organic', utm_source: 'google', utm_medium: 'organic' },
  { slug: 'paid_search', name: 'Paid search', grp: 'paid', utm_source: 'google', utm_medium: 'cpc' },
  { slug: 'email', name: 'Email', grp: 'owned', utm_source: 'newsletter', utm_medium: 'email' },
  { slug: 'events', name: 'Events and open days', grp: 'offline', utm_source: 'event', utm_medium: 'offline' },
  { slug: 'referrals', name: 'Referrals', grp: 'referral', utm_source: 'referral', utm_medium: 'referral' },
  { slug: 'chatbot', name: 'Chatbot', grp: 'owned', utm_source: 'chatbot', utm_medium: 'chat' },
  { slug: 'partners', name: 'Partners and press', grp: 'referral', utm_source: 'partner', utm_medium: 'partner' },
];
export const DEFAULT_RULES = [
  ['instagram', 'paid_social', 'paid_social'], ['facebook', 'paid_social', 'paid_social'], ['meta', 'paid_social', 'paid_social'],
  ['instagram', 'social', 'organic_social'], ['facebook', 'social', 'organic_social'], ['linkedin', 'social', 'organic_social'], ['telegram', 'social', 'organic_social'],
  ['google', 'organic', 'search_website'], ['bing', 'organic', 'search_website'], ['direct', 'none', 'search_website'], ['website', 'referral', 'search_website'],
  ['google', 'cpc', 'paid_search'],
  ['newsletter', 'email', 'email'], ['email', 'email', 'email'],
  ['event', 'offline', 'events'], ['open_day', 'offline', 'events'],
  ['referral', 'referral', 'referrals'],
  ['chatbot', 'chat', 'chatbot'],
  ['partner', 'partner', 'partners'], ['press', 'partner', 'partners'], ['university', 'partner', 'partners'],
];

export function listChannels() { return q('SELECT * FROM channels ORDER BY id'); }
export function channelBySlug(slug) { return one('SELECT * FROM channels WHERE slug = ?', slug); }

// Map utm_source/utm_medium to a channel; unknown pairs land in the review queue (never "other").
export function mapUtm(source, medium, origin = 'unknown') {
  const s = String(source || '').trim().toLowerCase();
  const m = String(medium || '').trim().toLowerCase();
  if (!s && !m) return null;
  const rule = one('SELECT channel_id FROM channel_rules WHERE utm_source = ? AND utm_medium = ?', s, m)
    || one(`SELECT channel_id FROM channel_rules WHERE utm_source = '*' AND utm_medium = ?`, m);
  if (rule) return rule.channel_id;
  const value = `${s} / ${m}`;
  run(
    `INSERT INTO unmapped_values (source, field, value, first_seen_at, count) VALUES (?,?,?,?,1)
     ON CONFLICT(source, field, value) DO UPDATE SET count = count + 1`,
    origin, 'utm_source/utm_medium', value, now(),
  );
  return null;
}

export function resolveUnmapped(id, channelId, actor) {
  const u = one('SELECT * FROM unmapped_values WHERE id = ?', id);
  if (!u) throw notFound();
  const [s, m] = u.value.split(' / ');
  run('INSERT OR REPLACE INTO channel_rules (utm_source, utm_medium, channel_id) VALUES (?,?,?)', s, m, channelId);
  run('UPDATE unmapped_values SET resolved_channel_id = ? WHERE id = ?', channelId, id);
  // Re-map touchpoints already stored with this pair.
  run('UPDATE touchpoints SET channel_id = ? WHERE channel_id IS NULL AND lower(utm_source) = ? AND lower(utm_medium) = ?', channelId, s, m);
  audit(actor, 'taxonomy.map', { meta: { value: u.value, channelId } });
  return { ok: true };
}

export function campaignByUtm(utmCampaign, channelId, { autoCreate = true, at } = {}) {
  if (!utmCampaign) return null;
  const c = one('SELECT * FROM campaigns WHERE utm_campaign = ?', utmCampaign);
  if (c || !autoCreate || !channelId) return c || null;
  const r = run('INSERT INTO campaigns (channel_id, name, utm_campaign, start_date, created_at) VALUES (?,?,?,?,?)', channelId, utmCampaign.replace(/[_-]+/g, ' '), utmCampaign, at ? isoDate(at) : null, now());
  return one('SELECT * FROM campaigns WHERE id = ?', Number(r.lastInsertRowid));
}

export function listCampaigns() {
  return q(`SELECT ca.*, ch.name channel_name, ch.slug channel_slug FROM campaigns ca JOIN channels ch ON ch.id = ca.channel_id ORDER BY ca.start_date DESC, ca.id DESC`);
}
export function saveCampaign(data, actor, id) {
  const slug = String(data.utm_campaign || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  if (!data.name || !slug || !data.channel_id) throw bad('Name, channel and utm_campaign are required');
  if (id) {
    run('UPDATE campaigns SET name=?, channel_id=?, utm_campaign=?, start_date=?, end_date=?, budget_amd=?, is_recruitment=? WHERE id=?',
      data.name, data.channel_id, slug, data.start_date || null, data.end_date || null, data.budget_amd ?? null, data.is_recruitment === false ? 0 : 1, id);
  } else {
    if (one('SELECT 1 FROM campaigns WHERE utm_campaign = ?', slug)) throw bad('That utm_campaign is already used');
    id = Number(run('INSERT INTO campaigns (channel_id, name, utm_campaign, start_date, end_date, budget_amd, owner_id, is_recruitment, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      data.channel_id, data.name, slug, data.start_date || null, data.end_date || null, data.budget_amd ?? null, actor?.id ?? null, data.is_recruitment === false ? 0 : 1, now()).lastInsertRowid);
  }
  audit(actor, 'campaign.save', { entity: 'campaign', entityId: id, meta: { name: data.name } });
  return one('SELECT * FROM campaigns WHERE id = ?', id);
}

// ---------- Link builder (ANL-04) ----------
export function buildLink({ url, campaign_id, content, term }, actor) {
  let u;
  try { u = new URL(url); } catch { throw bad('Enter a full URL starting with https://'); }
  if (!/^https?:$/.test(u.protocol)) throw bad('Only http and https links can be tagged');
  const camp = one(`SELECT ca.*, ch.utm_source, ch.utm_medium FROM campaigns ca JOIN channels ch ON ch.id = ca.channel_id WHERE ca.id = ?`, campaign_id);
  if (!camp) throw bad('Choose a campaign');
  u.searchParams.set('utm_source', camp.utm_source);
  u.searchParams.set('utm_medium', camp.utm_medium);
  u.searchParams.set('utm_campaign', camp.utm_campaign);
  if (content) u.searchParams.set('utm_content', String(content).trim().toLowerCase().replace(/\s+/g, '_'));
  if (term) u.searchParams.set('utm_term', String(term).trim());
  const tagged = u.toString();
  const code = randomId(5);
  run('INSERT INTO short_links (code, url, campaign_id, created_by, created_at) VALUES (?,?,?,?,?)', code, tagged, campaign_id, actor?.id ?? null, now());
  audit(actor, 'link.create', { meta: { campaign_id, code } });
  return { tagged, short: `${config.baseUrl}/l/${code}`, code };
}
export function listLinks(limit = 50) {
  return q(`SELECT s.*, ca.name campaign_name FROM short_links s LEFT JOIN campaigns ca ON ca.id = s.campaign_id ORDER BY s.created_at DESC LIMIT ?`, limit)
    .map((l) => ({ ...l, short: `${config.baseUrl}/l/${l.code}` }));
}
export function followShortLink(code) {
  const l = one('SELECT * FROM short_links WHERE code = ?', code);
  if (!l) return null;
  run('UPDATE short_links SET hits = hits + 1 WHERE code = ?', code);
  return l.url;
}

// ---------- FX (9.2): AMD at the Central Bank of Armenia rate on the spend date ----------
export function fxRate(currency, date) {
  const cur = String(currency || 'AMD').toUpperCase();
  if (cur === 'AMD') return 1;
  const r = one('SELECT rate_amd FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1', cur, isoDate(date))
    || one('SELECT rate_amd FROM fx_rates WHERE currency = ? ORDER BY date ASC LIMIT 1', cur);
  if (!r) throw bad(`No exchange rate for ${cur}; add one in Costs → Exchange rates`);
  return r.rate_amd;
}
export function setFxRate(currency, date, rate, actor) {
  if (!(rate > 0)) throw bad('Rate must be positive');
  run('INSERT OR REPLACE INTO fx_rates (currency, date, rate_amd) VALUES (?,?,?)', String(currency).toUpperCase(), isoDate(date), Number(rate));
  audit(actor, 'fx.set', { meta: { currency, date, rate } });
}
export const listFx = () => q('SELECT * FROM fx_rates ORDER BY currency, date DESC');

// ---------- Costs (ANL-05) ----------
export function addCost(data, actor, { source = 'manual', sourceRef = null } = {}) {
  const amount = Number(data.amount);
  if (!(amount >= 0)) throw bad('Amount must be a positive number');
  if (!data.channel_id) throw bad('Choose a channel');
  if (!data.date_from || !data.date_to || data.date_to < data.date_from) throw bad('Enter a valid date range');
  const currency = String(data.currency || 'AMD').toUpperCase();
  const rate = fxRate(currency, data.date_from);
  const values = [data.channel_id, data.campaign_id || null, isoDate(data.date_from), isoDate(data.date_to), Math.round(amount * rate), amount, currency, rate, source, sourceRef, data.note || null, actor?.id ?? null, now()];
  if (sourceRef) {
    run(`INSERT INTO costs (channel_id, campaign_id, date_from, date_to, amount_amd, original_amount, original_currency, fx_rate, source, source_ref, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_ref) DO UPDATE SET amount_amd = excluded.amount_amd, original_amount = excluded.original_amount, fx_rate = excluded.fx_rate, campaign_id = excluded.campaign_id`, ...values);
  } else {
    run(`INSERT INTO costs (channel_id, campaign_id, date_from, date_to, amount_amd, original_amount, original_currency, fx_rate, source, source_ref, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...values);
  }
  if (source === 'manual') audit(actor, 'cost.add', { meta: { channel: data.channel_id, amount, currency } });
  return true;
}
export function listCosts({ from, to, source } = {}) {
  const where = ['1=1']; const p = [];
  if (from) { where.push('c.date_to >= ?'); p.push(from); }
  if (to) { where.push('c.date_from <= ?'); p.push(to); }
  if (source) { where.push('c.source = ?'); p.push(source); }
  return q(`SELECT c.*, ch.name channel_name, ca.name campaign_name FROM costs c JOIN channels ch ON ch.id = c.channel_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id
            WHERE ${where.join(' AND ')} ORDER BY c.date_from DESC, c.id DESC LIMIT 500`, ...p);
}
export function deleteCost(id, actor) {
  const c = one('SELECT * FROM costs WHERE id = ?', id);
  if (!c) throw notFound();
  if (c.source !== 'manual') throw bad('Only manual costs can be deleted here; API costs come from the source');
  run('DELETE FROM costs WHERE id = ?', id);
  audit(actor, 'cost.delete', { entity: 'cost', entityId: id });
}

// Cost of a channel (or campaign) in a date range, prorated by days of overlap.
export function costInRange({ from, to, channelId, campaignId }) {
  const where = ['date_to >= ?', 'date_from <= ?']; const p = [from, to];
  if (channelId) { where.push('channel_id = ?'); p.push(channelId); }
  if (campaignId) { where.push('campaign_id = ?'); p.push(campaignId); }
  let total = 0;
  for (const c of q(`SELECT date_from, date_to, amount_amd FROM costs WHERE ${where.join(' AND ')}`, ...p)) {
    const days = (new Date(c.date_to) - new Date(c.date_from)) / 864e5 + 1;
    const ov = (Math.min(new Date(c.date_to), new Date(to)) - Math.max(new Date(c.date_from), new Date(from))) / 864e5 + 1;
    if (ov > 0) total += c.amount_amd * Math.min(1, ov / days);
  }
  return Math.round(total);
}

export function seedTaxonomy() {
  tx(() => {
    for (const c of DEFAULT_CHANNELS) run('INSERT OR IGNORE INTO channels (slug, name, grp, utm_source, utm_medium) VALUES (?,?,?,?,?)', c.slug, c.name, c.grp, c.utm_source, c.utm_medium);
    for (const [s, m, slug] of DEFAULT_RULES) run('INSERT OR IGNORE INTO channel_rules (utm_source, utm_medium, channel_id) VALUES (?,?,(SELECT id FROM channels WHERE slug = ?))', s, m, slug);
  });
}

// Sending domains and authentication (7.2, EML-02, EML-03, EML-07, EML-08, EML-12).
import dns from 'node:dns/promises';
import { q, one, run, now, json, parse } from '../../db.js';
import { bad, notFound, cleanEmail, isEmail } from '../../lib/util.js';
import { audit, getSetting } from '../../lib/core.js';

export const ESP_SPF_INCLUDE = 'include:spf.esp-provider.example';

// The exact records the administrator adds at the DNS host (EML-02).
export function requiredRecords(d) {
  const reportTo = `mailto:dmarc-reports@${d.domain.split('.').slice(-2).join('.')}`;
  return [
    { kind: 'SPF', type: 'TXT', host: d.domain, value: `v=spf1 ${ESP_SPF_INCLUDE} -all`, note: 'Authorizes only the email provider to send for this subdomain. Keep under 10 DNS lookups.' },
    { kind: 'DKIM', type: 'CNAME', host: `${d.dkim_selector}._domainkey.${d.domain}`, value: `${d.dkim_selector}.dkim.esp-provider.example`, note: '2048-bit key published by the provider. Rotate yearly using a second selector.' },
    { kind: 'DMARC', type: 'TXT', host: `_dmarc.${d.domain}`, value: `v=DMARC1; p=${d.dmarc_policy}; rua=${reportTo}; adkim=s; aspf=s; pct=100`, note: 'Start at p=none, quarantine after two clean weeks, then reject.' },
    { kind: 'Tracking', type: 'CNAME', host: d.tracking_domain, value: 'track.esp-provider.example', note: 'Branded HTTPS tracking domain that matches the sender.' },
  ];
}

const flat = (txt) => txt.map((parts) => parts.join(''));
async function safe(fn) { try { return await fn(); } catch { return null; } }

// Live DNS verification. Domains in "simulated" mode (local demo) pass when the
// administrator marks them verified; real domains are checked against DNS.
export async function verifyDomain(id, actor) {
  const d = getDomain(id);
  if (!d) throw notFound('Domain not found');
  const results = {};
  if (d.verification_mode === 'simulated') {
    Object.assign(results, { spf: 'verified', dkim: 'verified', dmarc: 'verified', tracking: 'verified' });
  } else {
    const spf = flat((await safe(() => dns.resolveTxt(d.domain))) || []).find((t) => t.startsWith('v=spf1'));
    results.spf = spf && spf.includes(ESP_SPF_INCLUDE.replace('include:', '')) ? 'verified' : spf ? 'mismatch' : 'missing';
    const dkimHost = `${d.dkim_selector}._domainkey.${d.domain}`;
    const dkim = (await safe(() => dns.resolveCname(dkimHost))) || flat((await safe(() => dns.resolveTxt(dkimHost))) || []);
    results.dkim = dkim && dkim.length ? 'verified' : 'missing';
    const dmarc = flat((await safe(() => dns.resolveTxt(`_dmarc.${d.domain}`))) || []).find((t) => t.startsWith('v=DMARC1'));
    results.dmarc = dmarc ? 'verified' : 'missing';
    const tr = await safe(() => dns.resolveCname(d.tracking_domain));
    results.tracking = tr && tr.length ? 'verified' : 'missing';
  }
  const all = ['spf', 'dkim', 'dmarc'].every((k) => results[k] === 'verified');
  run(
    `UPDATE sending_domains SET spf_status=?, dkim_status=?, dmarc_status=?, tracking_status=?, last_check=?, verified_at=CASE WHEN ? THEN COALESCE(verified_at, ?) ELSE NULL END,
       warmup_started_at = CASE WHEN ? AND warmup_started_at IS NULL THEN ? ELSE warmup_started_at END WHERE id=?`,
    results.spf, results.dkim, results.dmarc, results.tracking, now(), all ? 1 : 0, now(), all ? 1 : 0, now(), id,
  );
  audit(actor, 'domain.verify', { entity: 'domain', entityId: id, meta: results });
  return getDomain(id);
}

export const isDomainAuthenticated = (d) => d && d.spf_status === 'verified' && d.dkim_status === 'verified' && d.dmarc_status === 'verified';

export function getDomain(id) {
  const d = one('SELECT * FROM sending_domains WHERE id = ?', id);
  if (!d) return null;
  return { ...d, records: requiredRecords(d), authenticated: isDomainAuthenticated(d), warmup: warmupStatus(d) };
}
export function listDomains() { return q('SELECT id FROM sending_domains ORDER BY id').map((r) => getDomain(r.id)); }
export function defaultDomain(stream = 'marketing') {
  const r = one('SELECT id FROM sending_domains WHERE stream = ? ORDER BY verified_at IS NULL, id LIMIT 1', stream);
  return r ? getDomain(r.id) : null;
}

export function createDomain(data, actor) {
  const domain = String(data.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw bad('Enter a valid subdomain, for example news.academy-domain.am');
  const r = run(
    `INSERT INTO sending_domains (domain, from_address, from_name, tracking_domain, dkim_selector, verification_mode, stream) VALUES (?,?,?,?,?,?,?)`,
    domain, data.from_address || `news@${domain}`, data.from_name || 'Picsart Academy', data.tracking_domain || `click.${domain}`,
    data.dkim_selector || `mh${new Date().getFullYear()}`, data.verification_mode === 'simulated' ? 'simulated' : 'dns', data.stream === 'transactional' ? 'transactional' : 'marketing',
  );
  audit(actor, 'domain.create', { entity: 'domain', entityId: r.lastInsertRowid, meta: { domain } });
  return getDomain(Number(r.lastInsertRowid));
}

const POLICY_ORDER = ['none', 'quarantine', 'reject'];
export function setDmarcPolicy(id, policy, actor) {
  if (!POLICY_ORDER.includes(policy)) throw bad('Policy must be none, quarantine or reject');
  run('UPDATE sending_domains SET dmarc_policy = ? WHERE id = ?', policy, id);
  audit(actor, 'domain.dmarc_policy', { entity: 'domain', entityId: id, meta: { policy } });
  return getDomain(id);
}

export function rotateDkim(id, actor) {
  const d = getDomain(id);
  if (!d) throw notFound();
  const m = d.dkim_selector.match(/(\d+)$/);
  const next = m ? d.dkim_selector.replace(/\d+$/, String(Number(m[1]) + 1)) : `${d.dkim_selector}2`;
  run(`UPDATE sending_domains SET dkim_selector = ?, dkim_status = CASE WHEN verification_mode = 'simulated' THEN 'verified' ELSE 'unverified' END WHERE id = ?`, next, id);
  audit(actor, 'domain.dkim_rotate', { entity: 'domain', entityId: id, meta: { from: d.dkim_selector, to: next } });
  return getDomain(id);
}

// ---------- Warm-up (EML-08) ----------
export function warmupStatus(d) {
  const caps = getSetting('warmup_caps');
  if (!d.warmup_started_at) return { started: false, day: 0, cap: 0, sentToday: 0, remaining: 0, done: false };
  const day = Math.floor((Date.now() - new Date(d.warmup_started_at)) / 864e5);
  const done = day >= caps.length;
  const cap = done ? Infinity : caps[day];
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = one(
    `SELECT COUNT(*) n FROM deliveries dl JOIN sends s ON s.id = dl.send_id WHERE s.domain_id = ? AND dl.queued_at >= ? AND s.kind != 'test'`,
    d.id, startOfDay.toISOString(),
  ).n;
  return { started: true, day: day + 1, totalDays: caps.length, cap: done ? null : cap, sentToday, remaining: done ? Infinity : Math.max(0, cap - sentToday), done };
}

// ---------- DMARC aggregate reports (EML-07) ----------
const tag = (xml, name) => (xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1]?.trim();
export function parseDmarcReport(xml) {
  if (!/<feedback[\s>]/.test(xml)) throw bad('Not a DMARC aggregate report (missing <feedback>)');
  const meta = tag(xml, 'report_metadata') || '';
  const range = tag(meta, 'date_range') || '';
  const records = [...xml.matchAll(/<record>([\s\S]*?)<\/record>/g)].map((m) => {
    const r = m[1];
    const row = tag(r, 'row') || '';
    const pe = tag(row, 'policy_evaluated') || '';
    return {
      source_ip: tag(row, 'source_ip'), count: Number(tag(row, 'count') || 0),
      dkim: tag(pe, 'dkim'), spf: tag(pe, 'spf'), disposition: tag(pe, 'disposition'),
      header_from: tag(tag(r, 'identifiers') || '', 'header_from'),
    };
  });
  return {
    org: tag(meta, 'org_name'), report_id: tag(meta, 'report_id'),
    date_from: range ? new Date(Number(tag(range, 'begin')) * 1000).toISOString() : null,
    date_to: range ? new Date(Number(tag(range, 'end')) * 1000).toISOString() : null,
    records,
  };
}
export function storeDmarcReport(xml, actor) {
  const r = parseDmarcReport(xml);
  run('INSERT INTO dmarc_reports (org, report_id, date_from, date_to, records, created_at) VALUES (?,?,?,?,?,?)', r.org, r.report_id, r.date_from, r.date_to, json(r.records), now());
  audit(actor, 'dmarc.report_upload', { meta: { org: r.org, records: r.records.length } });
  return r;
}
export function dmarcSummary() {
  const reports = q('SELECT * FROM dmarc_reports ORDER BY date_to DESC LIMIT 30');
  const bySource = new Map(); let pass = 0; let total = 0;
  for (const rep of reports) for (const rec of parse(rep.records, [])) {
    const aligned = rec.dkim === 'pass' || rec.spf === 'pass';
    total += rec.count; if (aligned) pass += rec.count;
    const s = bySource.get(rec.source_ip) || { source_ip: rec.source_ip, pass: 0, fail: 0 };
    if (aligned) s.pass += rec.count; else s.fail += rec.count;
    bySource.set(rec.source_ip, s);
  }
  return { reports: reports.map((r) => ({ ...r, records: parse(r.records, []) })), passRate: total ? pass / total : null, total, sources: [...bySource.values()].sort((a, b) => b.fail - a.fail) };
}

// ---------- Address validation (EML-12) ----------
const mxCache = new Map();
export async function validateAddress(email, { checkMx = true } = {}) {
  const e = cleanEmail(email);
  if (!isEmail(e)) return { ok: false, reason: 'Invalid email address' };
  const domain = e.split('@')[1];
  if (getSetting('disposable_domains').includes(domain)) return { ok: false, reason: 'Disposable email domains are not accepted' };
  if (!checkMx) return { ok: true };
  if (!mxCache.has(domain)) {
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 2500));
    const res = await Promise.race([dns.resolveMx(domain).then((m) => (m.length ? 'ok' : 'none')).catch((err) => (err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? 'none' : 'unknown')), timeout]);
    mxCache.set(domain, res);
  }
  const r = mxCache.get(domain);
  if (r === 'none') return { ok: false, reason: `The domain ${domain} cannot receive email` };
  return { ok: true, mx: r };
}

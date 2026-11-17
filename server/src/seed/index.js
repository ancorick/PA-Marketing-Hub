// Demo data. Upstream systems (Core Engine, CRM, Alumni Tracker, Library, Launchpad,
// GA4, Meta, Google Ads) are simulated in ext_* tables and loaded through the real
// pipeline, and events arrive through the real Event Hub contract, so the demo
// exercises the same code paths as production. All people are fictional and use
// reserved example.* domains.
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { openDb, q, one, run, now, json, tx } from '../db.js';
import { prng, emailCmp, phoneNorm } from '../lib/util.js';
import { hashPassword, createApiKey } from '../lib/auth.js';
import { setSetting, raiseAlert, DEFAULT_SETTINGS } from '../lib/core.js';
import { seedTaxonomy, channelBySlug, setFxRate } from '../services/analytics/taxonomy.js';
import { upsertContact, recordConsent, unsubscribeAll, suppress } from '../services/audience.js';
import { ingestMessage } from '../services/eventhub.js';
import { runAll } from '../services/analytics/pipeline.js';
import { computeAttribution } from '../services/analytics/attribution.js';
import { saveSegment } from '../services/segments.js';
import { createIssues, newsletterSegment } from '../services/newsletter.js';
import { createSend } from '../services/email/sending.js';

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);
export const DEMO_PASSWORD = 'demo-password-2026';

const FIRST = ['Ani', 'Narek', 'Sona', 'Armen', 'Lilit', 'Davit', 'Mariam', 'Tigran', 'Anahit', 'Gor', 'Hayk', 'Nare', 'Arpi', 'Vahe', 'Karen', 'Lusine', 'Aram', 'Meri', 'Sargis', 'Mane', 'Levon', 'Elen', 'Arsen', 'Tatev', 'Hovhannes', 'Gayane', 'Ruben', 'Nune', 'Alex', 'Anna', 'Samvel', 'Siranush', 'Erik', 'Milena', 'Robert', 'Astghik'];
const LAST = ['Petrosyan', 'Hakobyan', 'Sargsyan', 'Grigoryan', 'Harutyunyan', 'Mkrtchyan', 'Avetisyan', 'Karapetyan', 'Hovhannisyan', 'Vardanyan', 'Gevorgyan', 'Ghazaryan', 'Manukyan', 'Khachatryan', 'Poghosyan', 'Martirosyan', 'Davtyan', 'Margaryan', 'Simonyan', 'Asatryan', 'Baghdasaryan', 'Galstyan', 'Melkonyan', 'Abrahamyan'];
const DOMAINS = ['example.com', 'example.org', 'example.net', 'mail.example.am'];
const COURSES = [
  { course: 'Python Backend', family: 'Python', roles: ['Junior backend developer', 'Python developer'] },
  { course: 'Frontend with React', family: 'Frontend', roles: ['Frontend developer', 'React developer'] },
  { course: 'QA Automation', family: 'QA', roles: ['QA engineer', 'Automation tester'] },
  { course: 'Data Analytics', family: 'Data', roles: ['Data analyst', 'BI analyst'] },
  { course: 'UI/UX Design', family: 'Design', roles: ['Product designer', 'UI designer'] },
  { course: 'Java Backend', family: 'Java', roles: ['Java developer', 'Backend engineer'] },
];
const COMPANIES = ['Picsart', 'Fintech startup', 'Gaming studio', 'Outsourcing company', 'E-commerce platform', 'Telecom company', 'AI startup', 'Bank IT department', 'Logistics platform', 'Healthtech startup'];
// First-touch mix and how well each channel converts (the shape from the PRD example).
const CHANNELS = {
  paid_social: { w: 0.31, enroll: 0.1, hire: 0.5 },
  search_website: { w: 0.19, enroll: 0.17, hire: 0.62 },
  events: { w: 0.13, enroll: 0.22, hire: 0.64 },
  referrals: { w: 0.08, enroll: 0.28, hire: 0.7 },
  organic_social: { w: 0.11, enroll: 0.13, hire: 0.55 },
  paid_search: { w: 0.08, enroll: 0.13, hire: 0.55 },
  chatbot: { w: 0.06, enroll: 0.12, hire: 0.55 },
  partners: { w: 0.04, enroll: 0.2, hire: 0.6 },
};
const UTM = {
  paid_social: ['instagram', 'paid_social'], search_website: ['google', 'organic'], events: ['event', 'offline'], referrals: ['referral', 'referral'],
  organic_social: ['instagram', 'social'], paid_search: ['google', 'cpc'], chatbot: ['chatbot', 'chat'], partners: ['partner', 'partner'], email: ['newsletter', 'email'],
};

export async function seed() {
  const r = prng(20261117);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + r() * (b - a);
  const pickW = (obj) => { const tot = Object.values(obj).reduce((s, v) => s + v.w, 0); let x = r() * tot; for (const [k, v] of Object.entries(obj)) { x -= v.w; if (x <= 0) return k; } return Object.keys(obj)[0]; };
  const NOW = Date.now();
  const START = NOW - 560 * DAY;
  const log = (m) => console.log(`[seed] ${m}`);

  // ---------- Base ----------
  tx(() => {
    for (const [email, name, role] of [
      ['admin@academy.test', 'Ani Admin', 'admin'], ['manager@academy.test', 'Mariam Manager', 'manager'], ['editor@academy.test', 'Erik Editor', 'editor'],
      ['viewer@academy.test', 'Vahe Viewer', 'viewer'], ['director@academy.test', 'Davit Director', 'leadership'],
    ]) run('INSERT OR IGNORE INTO users (email, name, role, password_hash, created_at) VALUES (?,?,?,?,?)', email, name, role, hashPassword(DEMO_PASSWORD), now());
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(k, v);
  });
  seedTaxonomy();
  // Approximate CBA rates for the demo; replace with official rates in production.
  for (let m = 0; m < 20; m++) {
    const d = new Date(START + m * 30 * DAY);
    setFxRate('USD', ymd(d.getTime()), Math.round(392 - m * 0.9 + between(-3, 3)), null);
    setFxRate('EUR', ymd(d.getTime()), Math.round(428 + m * 0.6 + between(-4, 4)), null);
  }
  const WORDINGS = {
    v1: { en: 'Send me news from Picsart Academy.', hy: 'Ուղարկեք ինձ Picsart Academy-ի նորությունները։', ru: 'Присылайте мне новости Picsart Academy.' },
    v2: { en: 'I agree to receive the selected emails from Picsart Academy. I can unsubscribe at any time with one click.', hy: 'Համաձայն եմ ստանալ ընտրված նամակները Picsart Academy-ից։ Կարող եմ ցանկացած պահի ապաբաժանորդագրվել մեկ սեղմումով։', ru: 'Я согласен получать выбранные письма от Picsart Academy. Я могу отписаться в любой момент одним кликом.' },
  };
  for (const [v, langs] of Object.entries(WORDINGS)) for (const t of ['newsletter', 'courses', 'events', 'alumni']) for (const [l, text] of Object.entries(langs)) {
    run('INSERT OR IGNORE INTO consent_wordings (version, topic, language, text, created_at) VALUES (?,?,?,?,?)', v, t, l, text, iso(v === 'v1' ? START : START + 200 * DAY));
  }
  run(`INSERT OR IGNORE INTO sending_domains (domain, from_address, from_name, tracking_domain, dkim_selector, dmarc_policy, verification_mode, stream, spf_status, dkim_status, dmarc_status, tracking_status, verified_at, last_check, warmup_started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, `news.${config.academy.domain}`, `news@news.${config.academy.domain}`, 'Picsart Academy', `click.news.${config.academy.domain}`, 'mh2026', 'quarantine', 'simulated', 'marketing',
  'verified', 'verified', 'verified', 'verified', iso(START), now(), iso(START));
  run(`INSERT OR IGNORE INTO sending_domains (domain, from_address, from_name, tracking_domain, dkim_selector, dmarc_policy, verification_mode, stream) VALUES (?,?,?,?,?,?,?,?)`,
    `mail.${config.academy.domain}`, `hello@mail.${config.academy.domain}`, 'Picsart Academy', `click.mail.${config.academy.domain}`, 'tx2026', 'none', 'dns', 'transactional');
  for (const e of ['qa-desktop@example.com', 'qa-mobile@example.com', 'marketing-team@example.com']) run('INSERT OR IGNORE INTO seed_list (email, label) VALUES (?,?)', e, 'seed');
  log('base data ready');

  // ---------- Campaigns ----------
  const ch = Object.fromEntries(Object.keys(UTM).map((k) => [k, channelBySlug(k)]));
  const addCampaign = (slug, name, utm, start, end, budget, recruit = 1) => {
    run('INSERT OR IGNORE INTO campaigns (channel_id, name, utm_campaign, start_date, end_date, budget_amd, is_recruitment, created_at) VALUES (?,?,?,?,?,?,?,?)', ch[slug].id, name, utm, start, end, budget, recruit, now());
    return utm;
  };
  const quarterCampaigns = [];
  for (let t = START; t < NOW; t += 91 * DAY) {
    const d = new Date(t); const yq = `${d.getUTCFullYear()}q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    for (const c of [COURSES[Math.floor(r() * 3)], COURSES[3 + Math.floor(r() * 3)]]) {
      quarterCampaigns.push({ from: t, to: Math.min(NOW, t + 91 * DAY), utm: addCampaign('paid_social', `Instagram · ${c.course} · ${yq.toUpperCase()}`, `ig_${c.family.toLowerCase()}_${yq}`, ymd(t), ymd(t + 90 * DAY), 3300000) });
    }
  }
  const gads = [addCampaign('paid_search', 'Google Ads · Programming courses', 'gads_programming', ymd(START), null, null), addCampaign('paid_search', 'Google Ads · Design and data', 'gads_design_data', ymd(START), null, null)];
  const evergreen = {
    organic_social: [addCampaign('organic_social', 'Instagram organic', 'ig_organic', ymd(START), null, null), addCampaign('organic_social', 'LinkedIn posts', 'li_organic', ymd(START), null, null)],
    search_website: [addCampaign('search_website', 'Website and SEO', 'seo_site', ymd(START), null, null)],
    referrals: [addCampaign('referrals', 'Student referral program', 'referral_program', ymd(START), null, null)],
    chatbot: [addCampaign('chatbot', 'Website chatbot', 'chatbot_site', ymd(START), null, null)],
    partners: [addCampaign('partners', 'University career fairs', 'partner_university_fair', ymd(START), null, null), addCampaign('partners', 'Tech media partnership', 'partner_media', ymd(START), null, null)],
  };
  const campaignFor = (slug, t) => {
    if (slug === 'paid_social') return (quarterCampaigns.filter((c) => t >= c.from && t < c.to).at(Math.floor(r() * 2)) || quarterCampaigns.at(-1)).utm;
    if (slug === 'paid_search') return pick(gads);
    return evergreen[slug] ? pick(evergreen[slug]) : null;
  };

  // ---------- Events (through the Event Hub contract) ----------
  const events = [];
  let msgN = 0;
  const msg = (type, data, at) => ingestMessage({ id: `seed-${++msgN}`, type, version: '1.0', occurred_at: at, data });
  for (let m = 0; m < 19; m++) {
    const base = START + m * 30 * DAY;
    if (base > NOW) break;
    const course = COURSES[m % COURSES.length];
    const mon = new Date(base).toLocaleString('en', { month: 'long', timeZone: 'UTC' });
    for (const [type, title, offset, cost] of [
      ['open_day', `Open day · ${mon}`, 8, 150000], ['workshop', `Workshop: ${course.family} in practice`, 16, 60000], ['info_session', `Info session: new ${course.course} group`, 24, 40000],
    ]) {
      const t = base + offset * DAY;
      if (t > NOW) continue;
      const eid = `EH-${ymd(t)}-${type}`;
      msg('event.created', { event_id: eid, title, type, starts_at: iso(t), public: true, registration_url: `https://${config.academy.domain}/events/${eid}`, language: 'hy', recording_url: type === 'workshop' && r() < 0.7 ? `https://${config.academy.domain}/recordings/${eid}` : null, media_public: type === 'workshop' }, iso(t - 20 * DAY));
      msg('event.cost_recorded', { cost_id: `${eid}-venue`, event_id: eid, amount: cost, currency: 'AMD', category: type === 'open_day' ? 'venue and catering' : 'materials' }, iso(t));
      events.push({ eid, t, type });
    }
    if (m % 4 === 3) {
      const t = base + 27 * DAY;
      if (t < NOW) { const eid = `EH-${ymd(t)}-graduation`; msg('event.created', { event_id: eid, title: `Graduation ceremony · ${mon}`, type: 'graduation', starts_at: iso(t), public: false, language: 'hy' }, iso(t - 30 * DAY)); events.push({ eid, t, type: 'graduation' }); }
    }
  }
  const publicEvents = events.filter((e) => e.type !== 'graduation');
  const eventBefore = (t) => publicEvents.filter((e) => e.t <= t && e.t > t - 45 * DAY).at(-1) || null;
  log(`${events.length} past events ingested through the Event Hub contract`);

  // ---------- People: leads -> applicants -> students -> alumni ----------
  const people = [];
  let pid = 0;
  const usedEmails = new Set();
  const mkPerson = (t) => {
    const first = pick(FIRST); const last = pick(LAST);
    let email; do { email = `${first}.${last}${Math.floor(r() * 900 + 100)}@${pick(DOMAINS)}`.toLowerCase(); } while (usedEmails.has(email));
    usedEmails.add(email);
    const lr = r();
    return { id: `P${String(++pid).padStart(5, '0')}`, first, last, email, phone: r() < 0.55 ? `+374 9${Math.floor(r() * 10)} ${Math.floor(r() * 900 + 100)} ${Math.floor(r() * 900 + 100)}` : null, language: lr < 0.62 ? 'hy' : lr < 0.82 ? 'en' : 'ru', t };
  };
  const webIdentified = []; const crm = []; const core = []; const alumni = []; const registrations = [];
  for (let day = 0; START + day * DAY < NOW - 2 * DAY; day++) {
    const t0 = START + day * DAY;
    const growth = 1 + day / 560 * 0.35;
    const n = Math.floor(between(1.6, 3.4) * growth);
    for (let k = 0; k < n; k++) {
      const p = mkPerson(t0);
      const first = pickW(CHANNELS);
      const course = pick(COURSES);
      const leadAt = t0 + between(0, DAY);
      const firstAt = first === 'referrals' ? leadAt - between(0, 3) * DAY : leadAt - between(4, 110) * DAY;
      const lastCh = r() < 0.55 || first === 'referrals' ? first : pick(['search_website', 'organic_social', 'chatbot', 'paid_search']);
      // First touch.
      if (first === 'events') {
        const ev = eventBefore(firstAt) || eventBefore(leadAt);
        if (ev) registrations.push({ p, ev, attended: r() < 0.85 });
        else webIdentified.push({ p, at: firstAt, type: 'visit', slug: 'search_website' });
      } else if (first !== 'referrals') webIdentified.push({ p, at: firstAt, type: 'visit', slug: first });
      // Middle touches.
      const mids = Math.floor(r() * 3);
      for (let i = 0; i < mids; i++) {
        const at = firstAt + (leadAt - firstAt) * between(0.2, 0.9);
        const slug = pick(['organic_social', 'search_website', 'events', 'paid_social']);
        if (slug === 'events') { const ev = eventBefore(at); if (ev) registrations.push({ p, ev, attended: r() < 0.7 }); } else webIdentified.push({ p, at, type: 'visit', slug });
      }
      const [s, m] = UTM[lastCh];
      const conv = CHANNELS[first];
      const enrolled = r() < conv.enroll;
      const applied = enrolled || r() < conv.enroll * 1.3;
      const appliedAt = applied ? leadAt + between(2, 25) * DAY : null;
      const enrolledAt = enrolled ? appliedAt + between(10, 35) * DAY : null;
      let stage = applied ? (enrolled ? 'enrolled' : (appliedAt > NOW - 20 * DAY ? pick(['applied', 'interview']) : pick(['rejected', 'dropped']))) : 'lead';
      if (appliedAt && appliedAt > NOW) stage = 'lead';
      crm.push({
        lead_id: `L${p.id.slice(1)}`, person_id: enrolled && enrolledAt < NOW ? p.id : null, email: p.email, first_name: p.first, last_name: p.last, phone: p.phone, language: p.language, course_family: course.family,
        created_at: iso(leadAt), stage, applied_at: appliedAt && appliedAt < NOW ? iso(appliedAt) : null, utm_source: s, utm_medium: m, utm_campaign: lastCh === 'events' ? null : campaignFor(lastCh, leadAt),
        self_reported_source: r() < 0.72 ? first : pick(Object.keys(CHANNELS)), origin: lastCh === 'chatbot' ? 'chatbot' : 'website', opt_in: r() < 0.7 ? 1 : 0, updated_at: iso(Math.min(NOW - DAY, (enrolledAt || appliedAt || leadAt) + DAY)),
      });
      if (lastCh !== first && lastCh !== 'events' && lastCh !== 'referrals') webIdentified.push({ p, at: leadAt - 60_000, type: 'form', slug: lastCh });
      if (enrolled && enrolledAt < NOW) {
        const gradAt = enrolledAt + between(150, 185) * DAY;
        const completed = r() < 0.82;
        const graduated = gradAt < NOW;
        core.push({ person_id: p.id, email: p.email, first_name: p.first, last_name: p.last, phone: p.phone, language: p.language, status: graduated ? (completed ? 'alumnus' : 'withdrawn') : 'student', course: course.course, course_family: course.family, group_code: `${course.family.slice(0, 3).toUpperCase()}-${ymd(enrolledAt).slice(2, 7).replace('-', '')}`, enrolled_at: iso(enrolledAt), graduated_at: graduated ? iso(gradAt) : null, completed: graduated && completed ? 1 : 0, updated_at: iso(Math.min(NOW - DAY, graduated ? gradAt + DAY : enrolledAt + DAY)) });
        if (graduated && completed) {
          const hired = r() < conv.hire;
          const start = gradAt + between(20, 210) * DAY;
          const employed = hired && start < NOW;
          alumni.push({ person_id: p.id, status: employed ? 'employed' : 'searching', company: employed ? pick(COMPANIES) : null, role: employed ? pick(course.roles) : null, start_date: employed ? iso(start) : null, feature_consent: r() < 0.45 ? 1 : 0, referred_enrolled: 0, updated_at: iso(Math.min(NOW - DAY, employed ? start + DAY : gradAt + 2 * DAY)) });
        }
      }
      people.push({ ...p, first, course, leadAt, enrolled, enrolledAt });
    }
  }
  // Referral credit to existing students/alumni.
  const referrals = people.filter((p) => p.first === 'referrals' && p.enrolled);
  for (const _ of referrals) { const a = pick(alumni.length ? alumni : [{ referred_enrolled: 0 }]); a.referred_enrolled = (a.referred_enrolled || 0) + 1; }
  // A few touchpoints the taxonomy does not know yet (unmapped queue, ANL-03).
  for (let i = 0; i < 14; i++) { const p = pick(people); webIdentified.push({ p, at: p.leadAt - between(1, 30) * DAY, type: 'visit', raw: pick([['tiktok', 'paid_social'], ['yandex', 'organic'], ['facebook', 'cpc']]) }); }

  tx(() => {
    for (const l of crm) run(`INSERT INTO ext_crm_leads (lead_id, person_id, email, first_name, last_name, phone, language, course_family, created_at, stage, applied_at, utm_source, utm_medium, utm_campaign, self_reported_source, origin, opt_in, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      l.lead_id, l.person_id, l.email, l.first_name, l.last_name, l.phone, l.language, l.course_family, l.created_at, l.stage, l.applied_at, l.utm_source, l.utm_medium, l.utm_campaign, l.self_reported_source, l.origin, l.opt_in, l.updated_at);
    for (const c of core) run(`INSERT INTO ext_core_people (person_id, email, first_name, last_name, phone, language, status, course, course_family, group_code, enrolled_at, graduated_at, completed, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.person_id, c.email, c.first_name, c.last_name, c.phone, c.language, c.status, c.course, c.course_family, c.group_code, c.enrolled_at, c.graduated_at, c.completed, c.updated_at);
    for (const a of alumni) run(`INSERT INTO ext_alumni (person_id, status, company, role, start_date, feature_consent, referred_enrolled, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      a.person_id, a.status, a.company, a.role, a.start_date, a.feature_consent, a.referred_enrolled, a.updated_at);
    let wi = 0;
    for (const w of webIdentified) {
      const [s, m] = w.raw || UTM[w.slug];
      run(`INSERT INTO ext_web_identified (id, email, occurred_at, type, utm_source, utm_medium, utm_campaign) VALUES (?,?,?,?,?,?,?)`, `ga4-id-${++wi}`, w.p.email, iso(w.at), w.type, s, m, w.raw ? `${s}_test` : campaignFor(w.slug, w.at));
    }
  });
  log(`${people.length} leads, ${core.length} enrolled students, ${alumni.length} graduates generated`);

  // Event registrations for these people, and walk-in guests (Event Hub contract).
  for (const reg of registrations) {
    const rid = `R-${reg.ev.eid}-${reg.p.id}`;
    if (one('SELECT 1 FROM event_registrations WHERE external_id = ?', rid)) continue;
    msg('registration.created', { registration_id: rid, event_id: reg.ev.eid, email: reg.p.email, first_name: reg.p.first, last_name: reg.p.last, language: reg.p.language, consent: { events: true, newsletter: r() < 0.6 }, consent_wording_version: reg.ev.t > START + 200 * DAY ? 'v2' : 'v1', registered_at: iso(reg.ev.t - between(2, 14) * DAY) }, iso(reg.ev.t - 3 * DAY));
    if (reg.attended) msg('checkin.recorded', { registration_id: rid, checked_in_at: iso(reg.ev.t + between(0, 2) * 3600e3) }, iso(reg.ev.t));
  }
  for (const ev of publicEvents) {
    const guests = Math.floor(between(8, 22));
    for (let i = 0; i < guests; i++) {
      const g = mkPerson(ev.t);
      const rid = `R-${ev.eid}-G${i}`;
      msg('registration.created', { registration_id: rid, event_id: ev.eid, email: g.email, first_name: g.first, last_name: g.last, language: g.language, consent: { events: true, newsletter: r() < 0.5 }, consent_wording_version: 'v2', registered_at: iso(ev.t - between(1, 10) * DAY) }, iso(ev.t - DAY));
      if (r() < 0.6) msg('checkin.recorded', { registration_id: rid, checked_in_at: iso(ev.t + 3600e3) }, iso(ev.t));
    }
  }
  log(`${registrations.length} lead registrations and walk-in guests ingested`);

  // ---------- Pure newsletter subscribers (website form, double opt-in) ----------
  tx(() => {
    for (let day = 0; START + day * DAY < NOW - DAY; day++) {
      const n = Math.floor(between(1, 4.5));
      for (let k = 0; k < n; k++) {
        const t = START + day * DAY + between(0, DAY);
        const p = mkPerson(t);
        const slug = pickW({ organic_social: { w: 0.35 }, search_website: { w: 0.3 }, paid_social: { w: 0.2 }, partners: { w: 0.05 }, events: { w: 0.1 } });
        const [s, m] = UTM[slug];
        const camp = slug === 'events' ? null : one('SELECT id FROM campaigns WHERE utm_campaign = ?', campaignFor(slug, t));
        const { contact } = upsertContact({ email: p.email, first_name: p.first, last_name: r() < 0.5 ? p.last : null, language: p.language, type: 'subscriber' },
          { method: 'form', consent: { newsletter: 'pending', events: r() < 0.4 ? 'pending' : 'unknown' }, wordingVersion: t > START + 200 * DAY ? 'v2' : 'v1', sourceUrl: '/signup', channelId: ch[slug].id, campaignId: camp?.id, firstTouchAt: iso(t), createdAt: iso(t), consentAt: iso(t) });
        // Most people confirm the double opt-in within minutes.
        if (r() < 0.9) for (const topic of ['newsletter', 'events']) {
          const st = one('SELECT state FROM consent_records WHERE contact_id = ? AND topic = ? ORDER BY id DESC LIMIT 1', contact.id, topic)?.state;
          if (st === 'pending') recordConsent(contact.id, topic, 'granted', 'confirm', { at: iso(t + 600e3), wordingVersion: 'v2' });
        } else run(`UPDATE contacts SET status = 'pending' WHERE id = ?`, contact.id);
        run(`INSERT OR IGNORE INTO touchpoints (contact_id, campaign_id, channel_id, type, occurred_at, source_system, source_ref, utm_source, utm_medium, utm_campaign) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          contact.id, camp?.id ?? null, ch[slug].id, 'form', iso(t), 'website_form', `seed-signup:${contact.id}`, s, m, camp ? campaignFor(slug, t) : null);
      }
    }
  });
  // Legacy import without a consent column (rule 2 of 6.3): unknown consent, never mailed.
  tx(() => {
    const b = Number(run(`INSERT INTO import_batches (filename, rows_total, rows_created, rows_updated, rows_invalid, has_consent_column, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`, 'old-event-signups-2024.csv', 180, 180, 0, 3, 0, 1, iso(START + 5 * DAY)).lastInsertRowid);
    for (let i = 0; i < 180; i++) { const p = mkPerson(START); upsertContact({ email: p.email, first_name: p.first, last_name: p.last, language: p.language, tags: ['legacy-2024'] }, { method: 'import', consent: { newsletter: 'unknown' }, importBatchId: b, createdAt: iso(START + 5 * DAY), firstTouchAt: iso(START + 5 * DAY), consentAt: iso(START + 5 * DAY) }); }
  });
  log('subscribers and legacy import created');

  // ---------- Marketing data feeds: GA4 sessions, social, ad spend ----------
  tx(() => {
    for (let day = 0; START + day * DAY < NOW; day++) {
      const t = START + day * DAY; const d = ymd(t); const wk = new Date(t).getUTCDay();
      const f = (wk === 0 || wk === 6 ? 0.7 : 1) * (1 + day / 560 * 0.3);
      for (const [slug, base] of [['search_website', 260], ['paid_social', 180], ['organic_social', 120], ['paid_search', 90], ['partners', 15], ['email', 40]]) {
        const [s, m] = UTM[slug];
        const sessions = Math.round(base * f * between(0.75, 1.25));
        run('INSERT INTO ext_web_sessions (id, date, utm_source, utm_medium, utm_campaign, sessions, conversions) VALUES (?,?,?,?,?,?,?)', `ga4-${d}-${slug}`, d, s, m, slug === 'paid_social' ? campaignFor(slug, t) : null, sessions, Math.round(sessions * between(0.008, 0.02)));
      }
      run('INSERT INTO ext_social_posts (id, date, platform, reach, engagement, followers, lead_forms) VALUES (?,?,?,?,?,?,?)', `ig-${d}`, d, 'instagram', Math.round(between(3000, 9000) * f), Math.round(between(150, 600) * f), Math.round(18000 + day * 14), Math.round(between(0, 4)));
      run('INSERT INTO ext_social_posts (id, date, platform, reach, engagement, followers, lead_forms) VALUES (?,?,?,?,?,?,?)', `li-${d}`, d, 'linkedin', Math.round(between(800, 2500) * f), Math.round(between(40, 160) * f), Math.round(5200 + day * 5), 0);
      // Meta Ads in AMD; Google Ads billed in USD (converted at the spend-date rate).
      for (const c of quarterCampaigns.filter((x) => t >= x.from && t < x.to)) {
        const spend = Math.round(between(7000, 11000));
        run('INSERT INTO ext_ad_spend (id, date, platform, utm_campaign, spend, currency, impressions, clicks, leads) VALUES (?,?,?,?,?,?,?,?,?)', `meta-${d}-${c.utm}`, d, 'meta', c.utm, spend, 'AMD', Math.round(spend * between(0.5, 0.8)), Math.round(spend / between(180, 260)), Math.round(between(0, 3)));
      }
      for (const g of gads) {
        const usd = Math.round(between(9, 15) * 100) / 100;
        run('INSERT INTO ext_ad_spend (id, date, platform, utm_campaign, spend, currency, impressions, clicks, leads) VALUES (?,?,?,?,?,?,?,?,?)', `gads-${d}-${g}`, d, 'google', g, usd, 'USD', Math.round(usd * between(80, 120)), Math.round(usd * between(1.5, 3)), Math.round(between(0, 2)));
      }
    }
    // Library resources and Launchpad groups (Newsletter sources).
    const RES = ['Clean Code practice set', 'Intro to SQL window functions', 'Design systems reading list', 'Testing with Playwright', 'React performance guide', 'Python async patterns', 'Data visualization basics', 'Java streams cheat sheet', 'Accessibility checklist', 'Git workflows for teams', 'System design primer notes', 'Figma auto-layout walkthrough'];
    for (let i = 0; i < 70; i++) {
      const t = START + (i / 70) * (NOW - START) + between(0, 5 * DAY);
      if (t > NOW) continue;
      const c = pick(COURSES);
      run('INSERT INTO ext_library (id, title, type, url, tags, is_public, added_at) VALUES (?,?,?,?,?,?,?)', `LIB-${i + 1}`, `${pick(RES)}${i > 11 ? ' · part ' + (Math.floor(i / 12) + 1) : ''}`, pick(['article', 'video', 'book', 'lesson recording']), r() < 0.93 ? `https://library.${config.academy.domain}/items/${i + 1}` : `http://files.example.net/${i + 1}`, json([c.family, pick(['beginner', 'intermediate'])]), r() < 0.85 ? 1 : 0, iso(t));
    }
    for (let m = 0; m < 21; m++) {
      const created = START + m * 28 * DAY;
      if (created > NOW) break;
      const c = COURSES[m % COURSES.length];
      run('INSERT INTO ext_launchpad_groups (id, course, course_family, start_date, open_for_applications, seats, created_at) VALUES (?,?,?,?,?,?,?)', `GRP-${m + 1}`, c.course, c.family, ymd(created + 40 * DAY), created + 40 * DAY > NOW ? 1 : 0, 18 + Math.floor(r() * 8), iso(created));
    }
    const grads = new Map();
    for (const c of core.filter((x) => x.graduated_at && x.completed)) {
      const k = c.group_code; const g = grads.get(k) || { course: c.course, group_code: k, graduates: 0, at: c.graduated_at };
      g.graduates++; if (c.graduated_at > g.at) g.at = c.graduated_at; grads.set(k, g);
    }
    for (const g of grads.values()) run('INSERT INTO ext_graduations (id, course, group_code, graduates, graduated_at) VALUES (?,?,?,?,?)', `GR-${g.group_code}`, g.course, g.group_code, g.graduates, g.at);
  });
  // Manual costs (ANL-05): agency fees, SEO, partner sponsorships, printing.
  tx(() => {
    for (let m = 0; START + m * 30 * DAY < NOW; m++) {
      const from = START + m * 30 * DAY; const to = Math.min(NOW, from + 29 * DAY);
      const addM = (slug, amount, note, cur = 'AMD') => run(`INSERT INTO costs (channel_id, campaign_id, date_from, date_to, amount_amd, original_amount, original_currency, fx_rate, source, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ch[slug].id, null, ymd(from), ymd(to), Math.round(amount * (cur === 'USD' ? 390 : 1)), amount, cur, cur === 'USD' ? 390 : 1, 'manual', note, 2, iso(to));
      addM('search_website', 320000, 'SEO agency and hosting');
      addM('organic_social', 180000, 'Content creator retainer');
      if (m % 3 === 0) addM('partners', 250000, 'University career fair booth');
      if (m % 2 === 0) addM('events', 45000, 'Printed flyers for open days');
    }
  });
  log('marketing data feeds loaded into the mock upstream systems');

  // ---------- Run the real pipeline (backfill) ----------
  const results = await runAll({ label: 'seed' }, { attribution: false });
  log(`pipeline: ${results.map((x) => `${x.source}=${x.status}${x.rowsIn != null ? `(${x.rowsIn})` : ''}`).join(', ')}`);

  // Students and alumni joining receive the onboarding consent form (newsletter, alumni).
  tx(() => {
    for (const c of q(`SELECT c.id, c.type, c.created_at, (SELECT MIN(occurred_at) FROM outcomes o WHERE o.contact_id = c.id AND o.type = 'enrolled') enrolled_at FROM contacts c WHERE c.type IN ('student','alumnus','lead','applicant')`)) {
      const at = c.enrolled_at || c.created_at;
      if (['student', 'alumnus'].includes(c.type) && r() < 0.88) { recordConsent(c.id, 'newsletter', 'granted', 'form', { at, wordingVersion: 'v2', sourceUrl: 'core-engine:onboarding' }); recordConsent(c.id, 'alumni', 'granted', 'form', { at, wordingVersion: 'v2', sourceUrl: 'core-engine:onboarding' }); }
      else if (r() < 0.5) recordConsent(c.id, 'newsletter', 'granted', 'form', { at, wordingVersion: 'v2', sourceUrl: '/apply' });
    }
  });

  // ---------- Historical newsletter and campaign sends ----------
  const domainId = one(`SELECT id FROM sending_domains WHERE stream = 'marketing'`).id;
  const emailCh = ch.email.id;
  // INSERT OR IGNORE keeps the previous lastInsertRowid when it skips, so look up first.
  const ensureEmailCampaign = (name, utm, at, recruit) => one('SELECT id FROM campaigns WHERE utm_campaign = ?', utm)?.id
    ?? Number(run('INSERT INTO campaigns (channel_id, name, utm_campaign, start_date, is_recruitment, created_at) VALUES (?,?,?,?,?,?)', emailCh, name, utm, ymd(at), recruit ? 1 : 0, now()).lastInsertRowid);
  const histSend = (kind, name, at, topic, language, subject, campaignUtm, blocksN = 5, clickRate = 0.065) => {
    const campId = ensureEmailCampaign(name, campaignUtm, at, kind === 'campaign');
    const sendId = Number(run(`INSERT INTO sends (kind, name, campaign_id, domain_id, subject, body, language, topic, status, scheduled_at, approved_by, approved_at, started_at, finished_at, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, kind, name, campId, domainId, subject, json([]), language, topic, 'sent', iso(at), 2, iso(at - DAY), iso(at), iso(at + 3600e3), 3, iso(at - 3 * DAY), iso(at)).lastInsertRowid);
    const recips = q(`SELECT c.id, c.email FROM contacts c WHERE c.email IS NOT NULL AND c.merged_into IS NULL AND c.created_at < ? ${language ? 'AND c.language = ?' : ''}
      AND EXISTS (SELECT 1 FROM consent_records cr WHERE cr.contact_id = c.id AND cr.topic = ? AND cr.state = 'granted' AND cr.recorded_at < ?)`, iso(at), ...(language ? [language] : []), topic, iso(at));
    let n = 0;
    for (const c of recips) {
      const x = r();
      const status = x < 0.004 ? 'bounced_hard' : x < 0.008 ? 'bounced_soft' : x < 0.0095 ? 'complained' : 'delivered';
      const opened = status === 'delivered' && r() < 0.42 ? iso(at + between(0.1, 72) * 3600e3) : null;
      const clicked = opened && r() < clickRate / 0.42 ? iso(new Date(opened).getTime() + between(1, 30) * 60e3) : null;
      const d = Number(run(`INSERT INTO deliveries (send_id, contact_id, email, esp_message_id, status, queued_at, delivered_at, opened_at, first_click_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        sendId, c.id, c.email, `<seed-${sendId}-${c.id}@${config.academy.domain}>`, status, iso(at), status === 'delivered' || status === 'complained' ? iso(at + 60e3) : null, opened, clicked).lastInsertRowid);
      if (clicked) {
        const block = `b${Math.floor(r() * blocksN) + 1}`;
        run('INSERT INTO link_clicks (delivery_id, block_id, url, clicked_at) VALUES (?,?,?,?)', d, block, `https://${config.academy.domain}/`, clicked);
        run(`INSERT OR IGNORE INTO touchpoints (contact_id, campaign_id, channel_id, type, occurred_at, source_system, source_ref, utm_source, utm_medium, utm_campaign) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          c.id, campId, emailCh, 'click', clicked, 'esp', `click:${d}`, kind === 'newsletter' ? 'newsletter' : 'email', 'email', campaignUtm);
      }
      if (status === 'bounced_hard') { suppress(c.email, 'hard_bounce', iso(at + 60e3)); run(`UPDATE contacts SET status = 'bounced' WHERE id = ?`, c.id); }
      if (status === 'complained') unsubscribeAll(c.id, 'complaint', { sendId });
      n++;
    }
    run('UPDATE sends SET sent_count = ?, recipient_count = ? WHERE id = ?', n, n, sendId);
    return sendId;
  };
  tx(() => {
    const first = new Date(START); first.setUTCDate(1);
    for (let m = 1; ; m++) {
      // Calendar months (not 30-day steps), so each month gets exactly one issue per language.
      const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + m, 5, 9, 0, 0));
      if (d.getTime() > NOW - 3 * DAY) break;
      for (const lang of ['hy', 'en', 'ru']) histSend('newsletter', `Academy newsletter · ${ymd(d.getTime()).slice(0, 7)} · ${lang.toUpperCase()}`, d.getTime(), 'newsletter', lang, lang === 'hy' ? 'Այս ամիս Ակադեմիայում' : lang === 'ru' ? 'В этом месяце в Академии' : 'This month at the Academy', `newsletter_${ymd(d.getTime()).slice(0, 7).replace('-', '_')}_${lang}`, 6);
    }
    histSend('campaign', 'Autumn enrollment · Python Backend', NOW - 34 * DAY, 'courses', null, 'New Python Backend group starts soon', 'email_python_autumn', 3, 0.09);
    histSend('campaign', 'Open day invitation · October', NOW - 48 * DAY, 'events', null, 'Come to our open day', 'email_open_day_oct', 2, 0.11);
  });
  // A few people unsubscribed over time.
  for (const c of q(`SELECT id FROM contacts WHERE status = 'active' AND type = 'subscriber' ORDER BY id LIMIT 2000`).filter(() => r() < 0.035)) unsubscribeAll(c.id, 'link', {});
  log('historical sends, unsubscribes and bounces recorded');

  // ---------- Duplicates for the merge review (AUD-04) ----------
  tx(() => {
    const sample = q(`SELECT * FROM contacts WHERE type = 'subscriber' AND status = 'active' AND email LIKE '%@example.com' ORDER BY id LIMIT 6`);
    for (const c of sample.slice(0, 3)) {
      const [local] = c.email.split('@');
      upsertContact({ email: `${local.replace('.', '')}+events@gmail.com`, first_name: c.first_name, last_name: c.last_name || 'Petrosyan', language: c.language }, { method: 'event', consent: { events: 'granted' }, createdAt: iso(NOW - 40 * DAY), firstTouchAt: iso(NOW - 40 * DAY), channelId: ch.events.id });
      run(`INSERT OR IGNORE INTO contacts (email, email_cmp, first_name, last_name, language, type, status, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        `${local.replace('.', '')}@gmail.com`, emailCmp(`${local.replace('.', '')}@gmail.com`), c.first_name, c.last_name || 'Petrosyan', c.language, 'subscriber', 'active', '[]', iso(NOW - 20 * DAY), iso(NOW - 20 * DAY));
    }
    for (const c of sample.slice(3)) {
      const phone = `+374 91 ${100 + c.id % 800} ${200 + c.id % 700}`;
      run('UPDATE contacts SET phone = ?, phone_norm = ? WHERE id = ?', phone, phoneNorm(phone), c.id);
      upsertContact({ email: `${c.first_name}.work${c.id}@example.org`.toLowerCase(), first_name: c.first_name, last_name: c.last_name, phone, language: c.language }, { method: 'form', consent: { newsletter: 'granted' }, createdAt: iso(NOW - 15 * DAY), firstTouchAt: iso(NOW - 15 * DAY), channelId: ch.organic_social.id });
    }
  });

  // ---------- Upcoming events (next 45 days) ----------
  const upcoming = [
    ['open_day', 'Open day · December', 9, true], ['workshop', 'Workshop: building your first API', 16, true],
    ['info_session', 'Info session: new Data Analytics group', 23, true], ['meetup', 'Alumni meetup (invite only)', 30, false],
  ];
  for (const [type, title, inDays, isPublic] of upcoming) {
    const t = NOW + inDays * DAY; const eid = `EH-${ymd(t)}-${type}`;
    msg('event.created', { event_id: eid, title, type, starts_at: iso(t), public: isPublic, registration_url: isPublic ? `https://${config.academy.domain}/events/${eid}` : null, language: 'hy' }, now());
  }

  // ---------- Attribution, segments, drafts ----------
  const n = computeAttribution();
  log(`attribution computed (${n} credit rows)`);
  const segs = [
    ['Open day attendees, not applied', 'PRD 6.4: attended an open day in the last 90 days, subscriber or lead, not in admissions', { match: 'all', conditions: [{ field: 'event_attended', op: 'within_days', value: { event_type: 'open_day', days: 90 } }, { field: 'type', op: 'in', value: ['subscriber', 'lead'] }, { field: 'in_active_admissions', op: 'is', value: false }] }],
    ['Alumni, Python track, hired', 'PRD 6.4', { match: 'all', conditions: [{ field: 'type', op: 'in', value: ['alumnus'] }, { field: 'course_family', op: 'in', value: ['Python'] }, { field: 'employment_status', op: 'in', value: ['employed'] }] }],
    ['Armenian-language newsletter', 'PRD 6.4', { match: 'all', conditions: [{ field: 'consent', op: 'granted', value: 'newsletter' }, { field: 'language', op: 'in', value: ['hy'] }] }],
    ['Re-engagement candidates', 'PRD 6.4: subscribed > 180 days, no open or click in 120 days', { match: 'all', conditions: [{ field: 'subscribed_days', op: 'gte', value: 180 }, { field: 'no_engagement_days', op: 'gte', value: 120 }] }],
    ['Referral champions', 'PRD 6.4: referred at least one enrolled student', { match: 'all', conditions: [{ field: 'type', op: 'in', value: ['student', 'alumnus'] }, { field: 'referred_enrolled', op: 'gte', value: 1 }] }],
    ['Course news · all languages', 'Everyone who asked for course news', { match: 'all', conditions: [{ field: 'consent', op: 'granted', value: 'courses' }] }],
  ];
  const segIds = {};
  for (const [name, description, rule] of segs) segIds[name] = saveSegment({ name, description, rule }, { id: 2, email: 'manager@academy.test' }).id;
  for (const l of ['hy', 'en', 'ru']) newsletterSegment(l);

  const manager = one(`SELECT * FROM users WHERE role = 'manager'`);
  const editor = one(`SELECT * FROM users WHERE role = 'editor'`);
  createSend({
    kind: 'campaign', name: 'Open day invitation · December', segment_id: segIds['Open day attendees, not applied'], topic: 'events', exclude_active_applicants: true,
    campaign_id: ensureEmailCampaign('Open day invitation · December', 'email_open_day_dec', NOW, true),
    subject: 'You came to an open day — the next groups start in January', preheader: 'See the new groups and book an interview',
    body: [
      { id: 'h1', type: 'heading', text: 'Thanks for visiting the Academy' },
      { id: 't1', type: 'text', text: 'New groups in **Python Backend**, **Data Analytics** and **UI/UX Design** start in January. Our next open day is a good moment to meet the lecturers and ask about the interview.' },
      { id: 'b1', type: 'button', label: 'Register for the open day', url: `https://${config.academy.domain}/events` },
      { id: 't2', type: 'text', text: 'Questions? Reply to this email and the Navigators team will answer.' },
    ],
  }, editor);
  await createIssues({}, editor);
  log('segments, a draft campaign and next month\'s newsletter drafts created');

  // ---------- Keys and alerts ----------
  const ccKey = createApiKey('Command Center', 'command_center');
  const ehKey = createApiKey('Event Hub', 'event_hub');
  raiseAlert('info', 'welcome', 'Demo data loaded. Sign in as manager@academy.test to approve sends, or editor@academy.test to edit the newsletter.');
  fs.writeFileSync(new URL('../../data/demo-keys.txt', import.meta.url), `Demo API keys (development only)\nCommand Center: ${ccKey}\nEvent Hub: ${ehKey}\nEvent Hub webhook secret: ${config.eventHubSecret}\nESP webhook secret: ${config.espWebhookSecret}\n`, { mode: 0o600 });
  log(`done. Users: admin@ / manager@ / editor@ / viewer@ / director@academy.test, password "${DEMO_PASSWORD}". API keys in server/data/demo-keys.txt`);
}

// `npm run seed`: start from an empty database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
  openDb();
  const t = Date.now();
  await seed();
  console.log(`[seed] finished in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
export const seedFile = fileURLToPath(import.meta.url);

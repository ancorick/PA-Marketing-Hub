// Public, no-login pages (AUD-08, AUD-09, AUD-10, AUD-11, AUD-20, NWS-12, NFR-P6).
// Server-rendered and dependency-free so a broken frontend never breaks unsubscribe.
import express from 'express';
import { config } from '../config.js';
import { one, run, now } from '../db.js';
import { escapeHtml, verifyToken, signToken, cleanEmail, bad } from '../lib/util.js';
import {
  getContact, unsubscribeAll, updatePreferences, consentMap, confirmSubscription, upsertContact, recordConsent, TOPICS, CURRENT_WORDING,
} from '../services/audience.js';
import { validateAddress } from '../services/email/domains.js';
import { espSend, recordClick } from '../services/email/esp.js';
import { renderEmail } from '../services/email/render.js';
import { defaultDomain } from '../services/email/domains.js';
import { recordTouchpoint } from '../services/analytics/pipeline.js';
import { followShortLink, mapUtm, campaignByUtm } from '../services/analytics/taxonomy.js';
import { archivedIssue, archiveList, issueToEmailBlocks } from '../services/newsletter.js';
import { rateLimit } from '../lib/http.js';
import { audit } from '../lib/core.js';

export const router = express.Router();

const S = {
  en: {
    unsubTitle: 'You are unsubscribed', unsubText: 'You will not receive marketing email from the Academy any more. It can take up to a minute for scheduled emails to drop you.',
    undo: 'Undo — keep me subscribed', prefs: 'Change preferences instead', prefsTitle: 'Email preferences', topics: 'What would you like to receive?',
    t: { newsletter: 'Monthly newsletter', courses: 'Course news and enrollment', events: 'Events and open days', alumni: 'Alumni community news' },
    language: 'Language', frequency: 'How often', freq: { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly' }, save: 'Save preferences', saved: 'Your preferences are saved.',
    unsubAll: 'Unsubscribe from everything', invalid: 'This link is not valid or has expired.', resubscribed: 'You are subscribed again. Thank you!',
    confirmTitle: 'Subscription confirmed', confirmText: 'Thank you — you will now receive the email you chose. You can change this at any time.',
    signupTitle: 'Get Academy news', email: 'Email', name: 'First name', interest: 'I am interested in a course', submit: 'Subscribe',
    checkInbox: 'Almost done: check your inbox and click the confirmation link.', privacy: 'Privacy notice', collected: 'What we store: your email, name, language, your choices above, and which emails you open or click (opens are estimated). We never sell or share your data.',
    consent: 'I agree to receive the selected emails from Picsart Academy. I can unsubscribe at any time with one click.',
    staySub: 'Thanks! You stay subscribed.',
  },
  hy: {
    unsubTitle: 'Դուք ապաբաժանորդագրվել եք', unsubText: 'Դուք այլևս չեք ստանա Ակադեմիայի գովազդային նամակներ։ Պլանավորված նամակներից հեռացումը կարող է տևել մինչև մեկ րոպե։',
    undo: 'Չեղարկել — թողնել բաժանորդագրությունը', prefs: 'Փոխել կարգավորումները', prefsTitle: 'Նամակների կարգավորումներ', topics: 'Ի՞նչ եք ցանկանում ստանալ',
    t: { newsletter: 'Ամսական տեղեկագիր', courses: 'Դասընթացների նորություններ', events: 'Միջոցառումներ և բաց դռների օրեր', alumni: 'Շրջանավարտների համայնք' },
    language: 'Լեզու', frequency: 'Հաճախականություն', freq: { weekly: 'Շաբաթական', monthly: 'Ամսական', quarterly: 'Եռամսյակային' }, save: 'Պահպանել', saved: 'Ձեր կարգավորումները պահպանված են։',
    unsubAll: 'Ապաբաժանորդագրվել ամեն ինչից', invalid: 'Հղումն անվավեր է կամ ժամկետանց։', resubscribed: 'Դուք կրկին բաժանորդագրված եք։ Շնորհակալություն։',
    confirmTitle: 'Բաժանորդագրությունը հաստատված է', confirmText: 'Շնորհակալություն։ Այժմ կստանաք ձեր ընտրած նամակները։',
    signupTitle: 'Ստացեք Ակադեմիայի նորությունները', email: 'Էլ. փոստ', name: 'Անուն', interest: 'Ինձ հետաքրքրում է դասընթաց', submit: 'Բաժանորդագրվել',
    checkInbox: 'Գրեթե պատրաստ է․ ստուգեք ձեր փոստը և սեղմեք հաստատման հղումը։', privacy: 'Գաղտնիության քաղաքականություն', collected: 'Մենք պահում ենք ձեր էլ. փոստը, անունը, լեզուն, ընտրությունները և թե որ նամակներն եք բացել կամ սեղմել։ Մենք երբեք չենք վաճառում ձեր տվյալները։',
    consent: 'Համաձայն եմ ստանալ ընտրված նամակները Picsart Academy-ից։ Կարող եմ ցանկացած պահի ապաբաժանորդագրվել մեկ սեղմումով։',
    staySub: 'Շնորհակալություն։ Դուք մնում եք բաժանորդագրված։',
  },
  ru: {
    unsubTitle: 'Вы отписались', unsubText: 'Вы больше не будете получать рекламные письма Академии. Удаление из запланированных рассылок занимает до минуты.',
    undo: 'Отменить — оставить подписку', prefs: 'Изменить настройки', prefsTitle: 'Настройки рассылки', topics: 'Что вы хотите получать?',
    t: { newsletter: 'Ежемесячная рассылка', courses: 'Новости курсов и набор', events: 'Мероприятия и дни открытых дверей', alumni: 'Новости сообщества выпускников' },
    language: 'Язык', frequency: 'Как часто', freq: { weekly: 'Еженедельно', monthly: 'Ежемесячно', quarterly: 'Раз в квартал' }, save: 'Сохранить', saved: 'Настройки сохранены.',
    unsubAll: 'Отписаться от всего', invalid: 'Ссылка недействительна или устарела.', resubscribed: 'Вы снова подписаны. Спасибо!',
    confirmTitle: 'Подписка подтверждена', confirmText: 'Спасибо! Теперь вы будете получать выбранные письма.',
    signupTitle: 'Новости Академии', email: 'Email', name: 'Имя', interest: 'Меня интересует курс', submit: 'Подписаться',
    checkInbox: 'Почти готово: проверьте почту и нажмите ссылку подтверждения.', privacy: 'Политика конфиденциальности', collected: 'Мы храним ваш email, имя, язык, ваш выбор и какие письма вы открыли или по каким ссылкам перешли. Мы никогда не продаём ваши данные.',
    consent: 'Я согласен получать выбранные письма от Picsart Academy. Я могу отписаться в любой момент одним кликом.',
    staySub: 'Спасибо! Вы остаётесь подписаны.',
  },
};
const pick = (req, contact) => {
  const l = (req.query.lang || req.body?.lang || contact?.language || 'en').toString();
  return S[l] ? l : 'en';
};

function page(lang, title, body) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(config.academy.name)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--quiet:#5b6470;--accent:#1f6feb;--rule:#e3e6ea;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#0f1215;--card:#171b20;--ink:#e8eaed;--quiet:#9aa4b0;--accent:#4c8dff;--rule:#2a3038;--ok:#3fb950}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Armenian",sans-serif}
main{max-width:560px;margin:48px auto;padding:0 16px}a{color:var(--accent)}.card{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:28px}
h1{font-size:24px;margin:0 0 12px}p{margin:0 0 14px;color:var(--quiet)}.brand{font-weight:700;letter-spacing:.04em;color:var(--accent);font-size:13px;margin-bottom:16px}
button,.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:600 15px system-ui,sans-serif;cursor:pointer;text-decoration:none}
.ghost{background:transparent;color:var(--accent);border:1px solid var(--rule)}label{display:block;margin:10px 0;color:var(--ink)}
input[type=email],input[type=text],select{width:100%;padding:10px;border:1px solid var(--rule);border-radius:8px;background:var(--card);color:var(--ink);font-size:15px}
fieldset{border:1px solid var(--rule);border-radius:8px;padding:12px 16px;margin:14px 0}legend{padding:0 6px;font-weight:600}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.ok{color:var(--ok);font-weight:600}.small{font-size:13px}
.langs{font-size:13px;margin-top:16px}.langs a{color:var(--quiet);margin-right:10px}.hp{position:absolute;left:-5000px}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
</style></head><body><main><div class="card"><div class="brand">${escapeHtml(config.academy.name.toUpperCase())}</div>${body}</div>
<p class="small" style="margin-top:14px">${escapeHtml(config.academy.name)} · ${escapeHtml(config.academy.address)} · <a href="/privacy?lang=${lang}">${S[lang].privacy}</a></p></main></body></html>`;
}
const langLinks = (path) => `<div class="langs"><a href="${path}${path.includes('?') ? '&' : '?'}lang=hy">Հայերեն</a><a href="${path}${path.includes('?') ? '&' : '?'}lang=en">English</a><a href="${path}${path.includes('?') ? '&' : '?'}lang=ru">Русский</a></div>`;

function contactFromToken(token) {
  const t = verifyToken(token);
  if (!t?.c) return null;
  const c = getContact(t.c);
  return c && c.status !== 'erased' ? { contact: c, sendId: t.s || null } : null;
}

// ---------- One-click unsubscribe (AUD-09) ----------
router.get('/u/:token', (req, res) => {
  const r = contactFromToken(req.params.token);
  const lang = pick(req, r?.contact);
  if (!r) return res.status(404).send(page(lang, S[lang].invalid, `<h1>${S[lang].invalid}</h1>`));
  if (r.contact.status !== 'unsubscribed') unsubscribeAll(r.contact.id, 'link', { sendId: r.sendId, ip: req.ip, sourceUrl: '/u' });
  res.send(page(lang, S[lang].unsubTitle, `<h1>${S[lang].unsubTitle}</h1><p>${S[lang].unsubText}</p>
    <div class="row"><form method="post" action="/u/${escapeHtml(req.params.token)}/undo"><input type="hidden" name="lang" value="${lang}"><button class="ghost" type="submit">${S[lang].undo}</button></form>
    <a class="btn ghost" href="/p/${escapeHtml(req.params.token)}?lang=${lang}">${S[lang].prefs}</a></div>${langLinks(`/u/${escapeHtml(req.params.token)}`)}`));
});
// RFC 8058 one-click POST from the mail client's native button (AUD-10).
router.post('/u/:token', express.urlencoded({ extended: false }), (req, res) => {
  const r = contactFromToken(req.params.token);
  if (!r) return res.status(404).send('invalid');
  unsubscribeAll(r.contact.id, 'link', { sendId: r.sendId, ip: req.ip, sourceUrl: 'list-unsubscribe-post' });
  res.status(200).send('unsubscribed');
});
router.post('/u/:token/undo', express.urlencoded({ extended: false }), (req, res) => {
  const r = contactFromToken(req.params.token);
  const lang = pick(req, r?.contact);
  if (!r) return res.status(404).send(page(lang, S[lang].invalid, `<h1>${S[lang].invalid}</h1>`));
  // The person re-confirms themselves, which is the only way back from an unsubscribe.
  for (const t of TOPICS) recordConsent(r.contact.id, t, 'granted', 'confirm', { ip: req.ip, wordingVersion: CURRENT_WORDING, sourceUrl: '/u/undo' });
  run(`UPDATE contacts SET status = 'active', updated_at = ? WHERE id = ? AND status = 'unsubscribed'`, now(), r.contact.id);
  audit({ label: 'contact' }, 'contact.resubscribe', { entity: 'contact', entityId: r.contact.id });
  res.send(page(lang, S[lang].resubscribed, `<h1 class="ok">${S[lang].resubscribed}</h1><a class="btn ghost" href="/p/${escapeHtml(req.params.token)}?lang=${lang}">${S[lang].prefs}</a>`));
});

// ---------- Preferences page (AUD-11) ----------
function prefsForm(token, c, lang, msg = '') {
  const s = S[lang];
  const cm = consentMap(c.id);
  const boxes = TOPICS.map((t) => `<label><input type="checkbox" name="topic_${t}" ${cm[t] === 'granted' ? 'checked' : ''}> ${s.t[t]}</label>`).join('');
  const sel = (name, opts, cur) => `<select name="${name}" id="${name}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return page(lang, s.prefsTitle, `<h1>${s.prefsTitle}</h1>${msg ? `<p class="ok" role="status">${msg}</p>` : ''}<p>${escapeHtml(c.email || '')}</p>
  <form method="post" action="/p/${escapeHtml(token)}"><input type="hidden" name="lang" value="${lang}">
  <fieldset><legend>${s.topics}</legend>${boxes}</fieldset>
  <label for="language">${s.language}</label>${sel('language', [['hy', 'Հայերեն'], ['en', 'English'], ['ru', 'Русский']], c.language)}
  <label for="frequency">${s.frequency}</label>${sel('frequency', Object.entries(s.freq), c.frequency)}
  <div class="row"><button type="submit">${s.save}</button><button class="ghost" type="submit" name="all" value="off">${s.unsubAll}</button></div></form>
  <p class="small" style="margin-top:16px">${s.collected}</p>${langLinks(`/p/${escapeHtml(token)}`)}`);
}
router.get('/p/:token', (req, res) => {
  const r = contactFromToken(req.params.token);
  const lang = pick(req, r?.contact);
  if (!r) return res.status(404).send(page(lang, S[lang].invalid, `<h1>${S[lang].invalid}</h1>`));
  res.send(prefsForm(req.params.token, r.contact, lang));
});
router.post('/p/:token', express.urlencoded({ extended: false }), (req, res) => {
  const r = contactFromToken(req.params.token);
  const lang = pick(req, r?.contact);
  if (!r) return res.status(404).send(page(lang, S[lang].invalid, `<h1>${S[lang].invalid}</h1>`));
  if (req.body.all === 'off') {
    unsubscribeAll(r.contact.id, 'link', { ip: req.ip, sourceUrl: '/p' });
    return res.send(page(lang, S[lang].unsubTitle, `<h1>${S[lang].unsubTitle}</h1><p>${S[lang].unsubText}</p>`));
  }
  const topics = Object.fromEntries(TOPICS.map((t) => [t, req.body[`topic_${t}`] === 'on']));
  // Re-granting after an unsubscribe is the person's own confirmed choice here.
  const wasOut = r.contact.status === 'unsubscribed';
  if (wasOut && Object.values(topics).some(Boolean)) {
    for (const t of TOPICS) if (topics[t]) recordConsent(r.contact.id, t, 'granted', 'confirm', { ip: req.ip, wordingVersion: CURRENT_WORDING, sourceUrl: '/p' });
    run(`UPDATE contacts SET status = 'active' WHERE id = ?`, r.contact.id);
  }
  updatePreferences(r.contact.id, { topics, language: req.body.language, frequency: req.body.frequency }, { ip: req.ip, sourceUrl: '/p' });
  res.send(prefsForm(req.params.token, getContact(r.contact.id), S[req.body.language] ? req.body.language : lang, S[lang].saved));
});

// ---------- Double opt-in (AUD-08) ----------
router.get('/confirm/:token', (req, res) => {
  const t = verifyToken(req.params.token);
  const c = t?.confirm ? getContact(t.confirm) : null;
  const lang = pick(req, c);
  if (!c) return res.status(404).send(page(lang, S[lang].invalid, `<h1>${S[lang].invalid}</h1>`));
  confirmSubscription(c.id, { ip: req.ip });
  res.send(page(lang, S[lang].confirmTitle, `<h1 class="ok">${S[lang].confirmTitle}</h1><p>${S[lang].confirmText}</p><a class="btn ghost" href="/p/${signToken({ c: c.id })}?lang=${lang}">${S[lang].prefs}</a>`));
});

// ---------- Sign-up endpoint (AUD-20) + demo form ----------
router.get('/signup', (req, res) => {
  const lang = pick(req);
  const s = S[lang];
  const hidden = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(req.query[k] || '')}">`).join('');
  res.send(page(lang, s.signupTitle, `<h1>${s.signupTitle}</h1>
  <form method="post" action="/api/public/signup">${hidden}<input type="hidden" name="language" value="${lang}"><input type="hidden" name="form" value="1">
  <label for="email">${s.email}</label><input id="email" type="email" name="email" required autocomplete="email">
  <label for="first_name">${s.name}</label><input id="first_name" type="text" name="first_name" autocomplete="given-name">
  <div class="hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  <fieldset><legend>${s.topics}</legend>${TOPICS.filter((t) => t !== 'alumni').map((t) => `<label><input type="checkbox" name="topics" value="${t}" ${t === 'newsletter' ? 'checked' : ''}> ${s.t[t]}</label>`).join('')}
  <label><input type="checkbox" name="course_interest" value="1"> ${s.interest}</label></fieldset>
  <p class="small">${s.consent} <a href="/privacy?lang=${lang}">${s.privacy}</a></p>
  <button type="submit">${s.submit}</button></form>${langLinks('/signup')}`));
});

router.post('/api/public/signup', rateLimit({ windowMs: 60_000, max: 10 }), express.urlencoded({ extended: false }), express.json(), async (req, res, next) => {
  try {
    const b = req.body || {};
    const lang = S[b.language] ? b.language : 'en';
    if (b.website) return res.status(200).json({ ok: true }); // honeypot: bots get a silent success
    const email = cleanEmail(b.email);
    const v = await validateAddress(email);
    if (!v.ok) throw bad(v.reason);
    const topics = (Array.isArray(b.topics) ? b.topics : b.topics ? [b.topics] : ['newsletter']).filter((t) => TOPICS.includes(t));
    const channelId = mapUtm(b.utm_source || 'website', b.utm_medium || 'referral', 'website_form');
    const camp = campaignByUtm(b.utm_campaign, channelId, { at: now() });
    const existing = one('SELECT id, status FROM contacts WHERE email = ?', email);
    const { contact } = upsertContact(
      { email, first_name: b.first_name, language: lang, type: b.course_interest ? 'lead' : 'subscriber', course_family: b.course_family },
      { method: 'form', consent: Object.fromEntries(topics.map((t) => [t, 'pending'])), wordingVersion: CURRENT_WORDING, sourceUrl: req.get('referer') || '/signup', ip: req.ip, channelId, campaignId: camp?.id, firstTouchAt: now(), pending: !existing },
    );
    recordTouchpoint({ contactId: contact.id, channelId, campaignId: camp?.id, type: 'form', at: now(), sourceSystem: 'website_form', sourceRef: `signup:${contact.id}:${Date.now()}`, utm_source: b.utm_source, utm_medium: b.utm_medium, utm_campaign: b.utm_campaign });
    // Course interest creates a lead in Navigator CRM with the same source (11.1).
    if (b.course_interest) {
      run(`INSERT OR IGNORE INTO ext_crm_leads (lead_id, email, first_name, language, course_family, created_at, stage, utm_source, utm_medium, utm_campaign, origin, opt_in, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, `mh-${contact.id}`, email, b.first_name || null, lang, b.course_family || null, now(), 'lead', b.utm_source || 'website', b.utm_medium || 'referral', b.utm_campaign || null, 'marketing_hub', topics.includes('courses') ? 1 : 0, now());
    }
    // Confirmation email is transactional: it does not depend on marketing consent.
    const domain = defaultDomain();
    const link = `${config.baseUrl}/confirm/${signToken({ confirm: contact.id }, 7)}?lang=${lang}`;
    const r = renderEmail([
      { id: 'h', type: 'heading', text: S[lang].signupTitle },
      { id: 't', type: 'text', text: S[lang].checkInbox },
      { id: 'b', type: 'button', label: S[lang].submit, url: link },
    ], { lang, topic: topics[0] || 'newsletter', preview: true, contactId: contact.id });
    await espSend({ to: email, from: `${domain.from_name} <${domain.from_address}>`, subject: S[lang].confirmTitle, html: r.html.replace(/\?utm_[^"]*/g, ''), text: r.text, headers: {}, idempotencyKey: `confirm:${contact.id}:${Date.now()}`, noSimulation: true });
    if (b.form) return res.send(page(lang, S[lang].signupTitle, `<h1>${S[lang].signupTitle}</h1><p class="ok" role="status">${S[lang].checkInbox}</p>`));
    res.json({ ok: true, status: 'pending_confirmation' });
  } catch (e) {
    if (req.body?.form && e.status === 400) {
      const lang = S[req.body.language] ? req.body.language : 'en';
      return res.status(400).send(page(lang, S[lang].signupTitle, `<h1>${S[lang].signupTitle}</h1><p role="alert">${escapeHtml(e.message)}</p><a class="btn ghost" href="/signup?lang=${lang}">←</a>`));
    }
    next(e);
  }
});

// ---------- Tracking (7.5) ----------
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
router.get('/t/o/:token', (req, res) => {
  const t = verifyToken(req.params.token);
  if (t?.d) run('UPDATE deliveries SET opened_at = COALESCE(opened_at, ?) WHERE id = ?', now(), t.d);
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }).send(PIXEL);
});
router.get('/t/c/:token', (req, res) => {
  const t = verifyToken(req.params.token);
  // The destination lives inside the signed token, so this is never an open redirect.
  if (!t?.u || !/^https?:\/\//.test(t.u)) return res.status(404).send('Link expired');
  if (t.d) recordClick(t.d, t.u, t.b || null);
  res.redirect(302, t.u);
});
router.get('/l/:code', (req, res) => {
  const url = followShortLink(req.params.code);
  if (!url) return res.status(404).send('Unknown link');
  res.redirect(302, url);
});
router.get('/stay-subscribed', (req, res) => { const lang = pick(req); res.send(page(lang, S[lang].staySub, `<h1 class="ok">${S[lang].staySub}</h1>`)); });

// ---------- Newsletter archive (NWS-12) ----------
router.get('/archive', (req, res) => {
  const lang = pick(req);
  const list = archiveList();
  res.send(page(lang, 'Archive', `<h1>Newsletter archive</h1>${list.length ? `<ul>${list.map((i) => `<li><a href="/archive/${escapeHtml(i.archive_slug)}">${escapeHtml(i.title)}</a> <span class="small">${i.language.toUpperCase()}</span></li>`).join('')}</ul>` : '<p>No issues yet.</p>'}`));
});
router.get('/archive/:slug', (req, res) => {
  const issue = archivedIssue(req.params.slug);
  if (!issue) return res.status(404).send(page('en', 'Not found', '<h1>Issue not found</h1>'));
  const r = renderEmail(issueToEmailBlocks(issue), { lang: issue.language, topic: 'newsletter', subject: issue.subject, preview: true });
  // Public copy: the footer links point to the sign-up form, never to someone's preferences.
  res.send(r.html.replace(/href="[^"]*\/(p|u)\/[^"]*"/g, 'href="/signup"'));
});

// ---------- Privacy notice (NFR-P6) ----------
router.get('/privacy', (req, res) => {
  const lang = pick(req);
  res.send(page(lang, S[lang].privacy, `<h1>${S[lang].privacy}</h1>
  <p>${escapeHtml(config.academy.name)} processes personal data for marketing under the Law of the Republic of Armenia on Protection of Personal Data. Where contacts are in the EU, GDPR principles for consent and erasure are followed.</p>
  <p><strong>What we collect:</strong> email, name, phone (optional), preferred language, which topics you agreed to and when (including the exact consent wording you saw), the campaign that brought you to us, events you registered for or attended, and which emails you received, opened (estimated) or clicked.</p>
  <p><strong>Why:</strong> to send the email you chose, and to learn which channels bring students who enroll, finish their course and get hired. Reports outside the marketing team only show aggregates.</p>
  <p><strong>What we never do:</strong> buy or rent lists, sell or share your data, use third-party tracking cookies, or scrape social networks.</p>
  <p><strong>Your rights:</strong> leave in one click from any email, change your choices on the preferences page, and ask for a copy of your data or its erasure; we answer within 30 days. Erasure keeps only a one-way hash of your address so we never email it again.</p>
  <p><strong>Retention:</strong> raw analytics data is kept 13 months; aggregated figures without personal data are kept longer.</p>`));
});

// Email rendering (EML-11, NWS-14, 8.4): HTML + plain text, 600px single column,
// live text, alt text, footer with sender identity, reason, preferences and
// unsubscribe links, every link tagged with campaign parameters and tracked.
import { config } from '../../config.js';
import { escapeHtml, signToken } from '../../lib/util.js';

const T = {
  en: {
    reason: { newsletter: 'You receive this because you subscribed to the Academy newsletter.', courses: 'You receive this because you asked for news about Academy courses.', events: 'You receive this because you asked to hear about Academy events.', alumni: 'You receive this as a member of the Academy alumni community.' },
    prefs: 'Manage preferences', unsub: 'Unsubscribe', view: 'View in browser',
  },
  hy: {
    reason: { newsletter: 'Դուք ստանում եք այս նամակը, քանի որ բաժանորդագրվել եք Ակադեմիայի տեղեկագրին։', courses: 'Դուք ստանում եք այս նամակը, քանի որ ցանկացել եք տեղեկանալ Ակադեմիայի դասընթացների մասին։', events: 'Դուք ստանում եք այս նամակը, քանի որ ցանկացել եք տեղեկանալ Ակադեմիայի միջոցառումների մասին։', alumni: 'Դուք ստանում եք այս նամակը որպես Ակադեմիայի շրջանավարտների համայնքի անդամ։' },
    prefs: 'Կարգավորումներ', unsub: 'Չեղարկել բաժանորդագրությունը', view: 'Բացել դիտարկիչում',
  },
  ru: {
    reason: { newsletter: 'Вы получили это письмо, потому что подписались на рассылку Академии.', courses: 'Вы получили это письмо, потому что хотели узнавать о курсах Академии.', events: 'Вы получили это письмо, потому что хотели узнавать о мероприятиях Академии.', alumni: 'Вы получили это письмо как участник сообщества выпускников Академии.' },
    prefs: 'Настройки подписки', unsub: 'Отписаться', view: 'Открыть в браузере',
  },
};
export const footerText = (lang) => T[lang] || T.en;

const BRAND = { ink: '#1b1f24', quiet: '#5b6470', accent: '#1f6feb', bg: '#f4f5f7', card: '#ffffff', rule: '#e3e6ea' };

// Add utm parameters unless the link already carries them (NWS-14).
export function tagUrl(url, { source = 'newsletter', medium = 'email', campaign, content } = {}) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', source);
    if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', medium);
    if (campaign && !u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', campaign);
    if (content && !u.searchParams.has('utm_content')) u.searchParams.set('utm_content', content);
    return u.toString();
  } catch { return url; }
}

// Inline formatting: **bold**, [text](url), line breaks. Input is escaped first.
function inline(text, linkFn) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label, url) => `<a href="${escapeHtml(linkFn(url.replace(/&amp;/g, '&')))}" style="color:${BRAND.accent}">${label}</a>`);
  return s.replace(/\n/g, '<br>');
}
function inlineText(text) {
  return String(text || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)');
}

/**
 * blocks: [{ id, type: heading|text|button|image|divider|item, text, title, url, label, src, alt, meta }]
 * ctx: { lang, topic, subject, preheader, campaign, deliveryId, contactId, sendId, archiveUrl, preview }
 */
export function renderEmail(blocks, ctx) {
  const lang = ctx.lang || 'en';
  const f = footerText(lang);
  const base = config.baseUrl;
  const track = (url, blockId) => {
    const tagged = tagUrl(url, { campaign: ctx.campaign, content: blockId });
    if (ctx.preview || !ctx.deliveryId) return tagged;
    return `${base}/t/c/${signToken({ d: ctx.deliveryId, u: tagged, b: blockId || null })}`;
  };
  const unsubToken = ctx.contactId ? signToken({ c: ctx.contactId, s: ctx.sendId || null }) : 'preview';
  const unsubscribeUrl = `${base}/u/${unsubToken}`;
  const preferencesUrl = `${base}/p/${unsubToken}`;

  const html = [];
  const text = [];
  for (const b of blocks || []) {
    const id = b.id ? String(b.id) : undefined;
    switch (b.type) {
      case 'heading':
        html.push(`<tr><td style="padding:24px 32px 8px;font:600 22px/1.3 Arial,Helvetica,sans-serif;color:${BRAND.ink}">${inline(b.text, (u) => track(u, id))}</td></tr>`);
        text.push(`\n${inlineText(b.text).toUpperCase()}\n`);
        break;
      case 'text':
        html.push(`<tr><td style="padding:8px 32px;font:15px/1.6 Arial,Helvetica,sans-serif;color:${BRAND.ink}">${inline(b.text, (u) => track(u, id))}</td></tr>`);
        text.push(inlineText(b.text));
        break;
      case 'item':
        html.push(`<tr><td style="padding:10px 32px;border-top:1px solid ${BRAND.rule}">
          <div style="font:600 16px/1.4 Arial,Helvetica,sans-serif;color:${BRAND.ink}">${b.url ? `<a href="${escapeHtml(track(b.url, id))}" style="color:${BRAND.ink};text-decoration:none">${escapeHtml(b.title)}</a>` : escapeHtml(b.title)}</div>
          ${b.meta ? `<div style="font:13px/1.5 Arial,Helvetica,sans-serif;color:${BRAND.quiet}">${escapeHtml(b.meta)}</div>` : ''}
          ${b.text ? `<div style="font:14px/1.5 Arial,Helvetica,sans-serif;color:${BRAND.ink};padding-top:4px">${inline(b.text, (u) => track(u, id))}</div>` : ''}
        </td></tr>`);
        text.push(`- ${b.title}${b.meta ? ' (' + b.meta + ')' : ''}${b.text ? '\n  ' + inlineText(b.text) : ''}${b.url ? '\n  ' + tagUrl(b.url, { campaign: ctx.campaign, content: id }) : ''}`);
        break;
      case 'button':
        if (!b.url) break;
        html.push(`<tr><td style="padding:16px 32px"><a href="${escapeHtml(track(b.url, id))}" style="display:inline-block;background:${BRAND.accent};color:#ffffff;font:600 15px Arial,Helvetica,sans-serif;padding:12px 22px;border-radius:6px;text-decoration:none">${escapeHtml(b.label || 'Learn more')}</a></td></tr>`);
        text.push(`${b.label || 'Learn more'}: ${tagUrl(b.url, { campaign: ctx.campaign, content: id })}`);
        break;
      case 'image':
        if (!b.src) break;
        html.push(`<tr><td style="padding:12px 32px"><img src="${escapeHtml(b.src.startsWith('/') ? base + b.src : b.src)}" alt="${escapeHtml(b.alt || '')}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:6px"></td></tr>`);
        if (b.alt) text.push(`[${b.alt}]`);
        break;
      case 'divider':
        html.push(`<tr><td style="padding:12px 32px"><hr style="border:0;border-top:1px solid ${BRAND.rule};margin:0"></td></tr>`);
        text.push('---');
        break;
      default:
        break;
    }
  }
  const reason = f.reason[ctx.topic] || f.reason.courses;
  const archive = ctx.archiveUrl ? `<a href="${escapeHtml(ctx.archiveUrl)}" style="color:${BRAND.quiet}">${f.view}</a> · ` : '';
  const pixel = !ctx.preview && ctx.deliveryId ? `<img src="${base}/t/o/${signToken({ d: ctx.deliveryId })}" width="1" height="1" alt="" style="display:block;border:0">` : '';

  const doc = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(ctx.subject || '')}</title>
<style>
  @media (max-width:620px){ .container{width:100%!important} td{padding-left:20px!important;padding-right:20px!important} }
  @media (prefers-color-scheme:dark){ body,.bg{background:#0f1215!important} .card{background:#171b20!important} td,div{color:#e8eaed!important} }
</style></head>
<body style="margin:0;padding:0;background:${BRAND.bg}" class="bg">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(ctx.preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:${BRAND.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" class="container card" style="width:600px;max-width:600px;background:${BRAND.card};border-radius:10px">
<tr><td style="padding:24px 32px 0;font:700 14px Arial,Helvetica,sans-serif;letter-spacing:.04em;color:${BRAND.accent}">${escapeHtml(config.academy.name.toUpperCase())}</td></tr>
${html.join('\n')}
<tr><td style="padding:24px 32px 28px;font:12px/1.6 Arial,Helvetica,sans-serif;color:${BRAND.quiet};border-top:1px solid ${BRAND.rule}">
${escapeHtml(reason)}<br>${escapeHtml(config.academy.name)} · ${escapeHtml(config.academy.address)}<br>
${archive}<a href="${escapeHtml(preferencesUrl)}" style="color:${BRAND.quiet}">${f.prefs}</a> · <a href="${escapeHtml(unsubscribeUrl)}" style="color:${BRAND.quiet}">${f.unsub}</a>
</td></tr></table>${pixel}
</td></tr></table></body></html>`;

  const plain = `${config.academy.name}\n\n${text.join('\n\n')}\n\n--\n${reason}\n${config.academy.name}, ${config.academy.address}\n${ctx.archiveUrl ? f.view + ': ' + ctx.archiveUrl + '\n' : ''}${f.prefs}: ${preferencesUrl}\n${f.unsub}: ${unsubscribeUrl}\n`;

  const headers = {
    'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@${config.academy.domain}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  return { html: doc, text: plain, headers, unsubscribeUrl, preferencesUrl };
}

export function extractLinks(blocks) {
  const links = [];
  for (const b of blocks || []) {
    if (b.url) links.push({ blockId: b.id, url: b.url });
    for (const m of String(b.text || '').matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) links.push({ blockId: b.id, url: m[1] });
  }
  return links;
}

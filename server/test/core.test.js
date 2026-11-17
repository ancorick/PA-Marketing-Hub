// Core rules from PRD 14.6: dedup, consent precedence, suppression, idempotent
// sends, attribution, metric suppression, Event Hub contract, signatures.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
process.env.NODE_ENV = 'test';

let U, DB, A, Seg, Send, Esp, Attr, M, EH, Tax, core, auth;
before(async () => {
  U = await import('../src/lib/util.js');
  DB = await import('../src/db.js');
  DB.openDb(path.join(process.env.MH_DATA_DIR, 'test.db'));
  A = await import('../src/services/audience.js');
  Seg = await import('../src/services/segments.js');
  Send = await import('../src/services/email/sending.js');
  Esp = await import('../src/services/email/esp.js');
  Attr = await import('../src/services/analytics/attribution.js');
  M = await import('../src/services/analytics/metrics.js');
  EH = await import('../src/services/eventhub.js');
  Tax = await import('../src/services/analytics/taxonomy.js');
  core = await import('../src/lib/core.js');
  auth = await import('../src/lib/auth.js');
  Tax.seedTaxonomy();
  DB.run(`INSERT INTO users (email, name, role, password_hash, created_at) VALUES ('m@t.test','M','manager',?,?)`, auth.hashPassword('x'.repeat(12)), DB.now());
  DB.run(`INSERT INTO sending_domains (domain, from_address, from_name, tracking_domain, dkim_selector, verification_mode, spf_status, dkim_status, dmarc_status, verified_at, warmup_started_at)
          VALUES ('news.test.am','news@news.test.am','Academy','click.news.test.am','s1','simulated','verified','verified','verified',?,?)`, DB.now(), new Date(Date.now() - 100 * 864e5).toISOString());
});
const manager = () => DB.one(`SELECT * FROM users WHERE role = 'manager'`);

test('email normalization ignores Gmail dots and plus tags, keeps other domains', () => {
  assert.equal(U.emailCmp(' Ani.Petrosyan+news@GMAIL.com '), 'anipetrosyan@gmail.com');
  assert.equal(U.emailCmp('ani.p+x@example.com'), 'ani.p@example.com');
  assert.equal(U.phoneNorm('093 123456'), '37493123456');
  assert.equal(U.phoneNorm('+374 93 12-34-56'), '37493123456');
});

test('signed tokens reject tampering and carry no personal data', () => {
  const t = U.signToken({ c: 42 });
  assert.deepEqual(U.verifyToken(t).c, 42);
  const [data] = t.split('.');
  assert.equal(U.verifyToken(`${data}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`), null);
  assert.ok(!Buffer.from(data, 'base64url').toString().includes('@'));
});

test('webhook signatures enforce the 5-minute replay window', () => {
  const body = '{"a":1}'; const ts = Math.floor(Date.now() / 1000);
  assert.ok(U.verifyWebhook('k', ts, body, U.signWebhook('k', ts, body)).ok);
  assert.equal(U.verifyWebhook('k', ts, body, U.signWebhook('other', ts, body)).ok, false);
  const old = ts - 600;
  assert.equal(U.verifyWebhook('k', old, body, U.signWebhook('k', old, body)).ok, false);
});

test('CSV export neutralises spreadsheet formulas', () => {
  assert.equal(U.toCsv([['=HYPERLINK("x")', 'ok']]), `"'=HYPERLINK(""x"")",ok`);
});

test('upsert matches the same person by normalized email instead of duplicating', () => {
  const a = A.upsertContact({ email: 'Narek.Avetisyan@gmail.com', first_name: 'Narek' }, { method: 'form', consent: { newsletter: 'granted' } });
  const b = A.upsertContact({ email: 'narekavetisyan+events@gmail.com' }, { method: 'event' });
  assert.equal(a.contact.id, b.contact.id);
  assert.equal(b.created, false);
});

test('consent: the most restrictive state wins; imports and staff cannot override a withdrawal', () => {
  const { contact } = A.upsertContact({ email: 'lilit@example.com' }, { method: 'form', consent: { newsletter: 'granted' } });
  A.unsubscribeAll(contact.id, 'link');
  assert.equal(A.consentState(contact.id, 'newsletter'), 'withdrawn');
  assert.ok(A.isSuppressed('lilit@example.com'));
  const r = A.upsertContact({ email: 'lilit@example.com' }, { method: 'import', consent: { newsletter: 'granted' } });
  assert.equal(r.consent.newsletter.state, 'withdrawn');
  assert.ok(r.consent.newsletter.ignored);
  assert.throws(() => A.recordConsent(contact.id, 'newsletter', 'granted', 'manual', { actor: manager() }), /reason/);
  assert.throws(() => A.recordConsent(contact.id, 'newsletter', 'granted', 'manual', { actor: manager(), reason: 'asked by phone' }), /suppression/);
  // Only the person's own confirmed opt-in brings them back.
  A.recordConsent(contact.id, 'newsletter', 'granted', 'confirm', { at: new Date(Date.now() + 1000).toISOString() });
  assert.equal(A.isSuppressed('lilit@example.com'), false);
});

test('consent log is append-only', () => {
  const c = A.findByEmail('lilit@example.com');
  assert.throws(() => DB.run(`UPDATE consent_records SET state = 'granted' WHERE contact_id = ?`, c.id), /append-only/);
  assert.throws(() => DB.run('DELETE FROM consent_records WHERE contact_id = ?', c.id), /append-only/);
  assert.throws(() => DB.run('DELETE FROM suppression'), /append-only/);
});

test('hard bounces and complaints are permanent suppressions', () => {
  A.upsertContact({ email: 'gone@example.com' }, { method: 'form', consent: { newsletter: 'granted' } });
  A.suppress('gone@example.com', 'hard_bounce');
  const c = A.findByEmail('gone@example.com');
  A.recordConsent(c.id, 'newsletter', 'granted', 'confirm', { at: new Date(Date.now() + 5000).toISOString() });
  assert.ok(A.isSuppressed('gone@example.com'));
});

test('merge keeps the earliest first touch, all history and the most restrictive consent', () => {
  const ch = Tax.channelBySlug('events');
  const old = A.upsertContact({ email: 'sona.old@example.com', first_name: 'Sona', last_name: 'Vardanyan' }, { method: 'form', consent: { newsletter: 'granted' }, firstTouchAt: '2025-01-01T00:00:00.000Z', channelId: ch.id }).contact;
  const neu = A.upsertContact({ email: 'sona.new@example.com', first_name: 'Sona', last_name: 'Vardanyan' }, { method: 'form', consent: { newsletter: 'withdrawn' }, firstTouchAt: '2026-01-01T00:00:00.000Z' }).contact;
  DB.run(`INSERT INTO touchpoints (contact_id, channel_id, type, occurred_at, source_system, source_ref) VALUES (?,?,?,?,?,?)`, neu.id, ch.id, 'visit', '2026-01-02T00:00:00.000Z', 'test', 'merge-1');
  const kept = A.mergeContacts(neu.id, old.id, manager());
  assert.equal(kept.first_touch_at, '2025-01-01T00:00:00.000Z');
  assert.equal(kept.source_channel_id, ch.id);
  assert.equal(A.consentState(neu.id, 'newsletter'), 'withdrawn');
  assert.equal(DB.one('SELECT merged_into FROM contacts WHERE id = ?', old.id).merged_into, neu.id);
  assert.equal(A.findByEmail('sona.old@example.com').id, neu.id);
});

test('erasure removes personal data but keeps the address suppressed', () => {
  const { contact } = A.upsertContact({ email: 'erase.me@example.com', first_name: 'Erase', phone: '+37491000000' }, { method: 'form', consent: { newsletter: 'granted' } });
  A.eraseContact(contact.id, manager());
  const c = A.getContact(contact.id);
  assert.equal(c.email, null); assert.equal(c.first_name, null); assert.equal(c.phone, null); assert.equal(c.status, 'erased');
  assert.ok(A.isSuppressed('erase.me@example.com'));
  assert.ok(DB.one('SELECT COUNT(*) n FROM consent_records WHERE contact_id = ?', contact.id).n > 0);
});

test('segment rules only accept whitelisted fields and bind values (no injection)', () => {
  assert.throws(() => Seg.compileRule({ match: 'all', conditions: [{ field: 'password_hash', op: 'in', value: ['x'] }] }), /Unknown segment field/);
  assert.throws(() => Seg.compileRule({ match: 'all', conditions: [{ field: 'type', op: 'like', value: 'x' }] }), /not allowed/);
  const before = DB.one('SELECT COUNT(*) n FROM contacts').n;
  const ids = Seg.evaluateRule({ match: 'all', conditions: [{ field: 'tag', op: 'has', value: "x'); DROP TABLE contacts;--" }] });
  assert.deepEqual(ids, []);
  assert.equal(DB.one('SELECT COUNT(*) n FROM contacts').n, before);
});

test('attribution models split credit as specified', () => {
  const t = [{ channel_id: 1, campaign_id: null }, { channel_id: 2, campaign_id: null }, { channel_id: 3, campaign_id: null }, { channel_id: 4, campaign_id: null }];
  assert.deepEqual(Attr.creditTouches(t, 'first_touch'), [{ channel_id: 1, campaign_id: null, credit: 1 }]);
  assert.deepEqual(Attr.creditTouches(t, 'last_touch'), [{ channel_id: 4, campaign_id: null, credit: 1 }]);
  const pb = Attr.creditTouches(t, 'position_based');
  const by = Object.fromEntries(pb.map((p) => [p.channel_id, p.credit]));
  assert.equal(by[1], 0.4); assert.equal(by[4], 0.4); assert.ok(Math.abs(by[2] - 0.1) < 1e-9); assert.ok(Math.abs(by[3] - 0.1) < 1e-9);
  assert.ok(Math.abs(pb.reduce((s, p) => s + p.credit, 0) - 1) < 1e-9);
  assert.deepEqual(Attr.creditTouches([], 'first_touch'), [{ channel_id: null, campaign_id: null, credit: 1 }]);
  assert.deepEqual(Attr.creditTouches(t.slice(0, 2), 'position_based').map((x) => x.credit), [0.5, 0.5]);
});

test('send-time recipients exclude suppressed, no-consent and active applicants', () => {
  A.upsertContact({ email: 'ok1@example.com' }, { method: 'form', consent: { courses: 'granted' } });
  A.upsertContact({ email: 'noconsent@example.com' }, { method: 'form', consent: { newsletter: 'granted' } });
  A.upsertContact({ email: 'applicant@example.com', type: 'applicant' }, { method: 'form', consent: { courses: 'granted' } });
  const seg = Seg.saveSegment({ name: 'Everyone', rule: { match: 'all', conditions: [] } }, manager());
  const s = Send.createSend({ name: 'Test', segment_id: seg.id, topic: 'courses', subject: 'Hi', body: [{ id: 't', type: 'text', text: 'Hello' }] }, manager());
  const r = Send.resolveRecipients(Send.getSend(s.id));
  const emails = r.ids.map((id) => A.getContact(id).email);
  assert.ok(emails.includes('ok1@example.com'));
  assert.ok(!emails.includes('noconsent@example.com'));
  assert.ok(!emails.includes('applicant@example.com'));
  assert.ok(r.excluded.active_applicants >= 1);
});

test('sending is idempotent: a restarted job never delivers twice', async () => {
  const seg = Seg.saveSegment({ name: 'Course news', rule: { match: 'all', conditions: [{ field: 'consent', op: 'granted', value: 'courses' }] } }, manager());
  const s = Send.createSend({ name: 'Idem', segment_id: seg.id, topic: 'courses', subject: 'Idempotent', body: [{ id: 't', type: 'text', text: 'Hello' }] }, manager());
  Send.startSend(s.id);
  await Send.deliverBatch(Send.getSend(s.id));
  const n1 = DB.one('SELECT COUNT(*) n FROM deliveries WHERE send_id = ?', s.id).n;
  // Simulate a crash/restart: the queue is rebuilt and the batch runs again.
  Send.startSend(s.id);
  await Send.deliverBatch(Send.getSend(s.id));
  assert.equal(DB.one('SELECT COUNT(*) n FROM deliveries WHERE send_id = ?', s.id).n, n1);
  assert.equal(DB.one('SELECT COUNT(*) n FROM esp_outbox WHERE idempotency_key LIKE ?', `send:${s.id}:%`).n, n1);
  const again = await Esp.espSend({ to: 'x@example.com', from: 'a', subject: 's', html: '', text: '', headers: {}, idempotencyKey: `send:${s.id}:${DB.one('SELECT contact_id FROM deliveries WHERE send_id = ?', s.id).contact_id}` });
  assert.equal(again.duplicate, true);
});

test('every marketing email carries one-click unsubscribe headers and a footer link', () => {
  const s = DB.one(`SELECT * FROM esp_outbox WHERE idempotency_key LIKE 'send:%' LIMIT 1`);
  const h = JSON.parse(s.headers);
  assert.match(h['List-Unsubscribe'], /\/u\//);
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(s.text, /\/u\/[\w.-]+/);
  assert.match(s.html, /href="[^"]*\/u\/[\w.-]+"/);
});

test('kill switch stops delivery', async () => {
  const seg = Seg.saveSegment({ name: 'Course news 2', rule: { match: 'all', conditions: [{ field: 'consent', op: 'granted', value: 'courses' }] } }, manager());
  A.upsertContact({ email: 'late@example.com' }, { method: 'form', consent: { courses: 'granted' } });
  const s = Send.createSend({ name: 'Kill', segment_id: seg.id, topic: 'courses', subject: 'K', body: [{ id: 't', type: 'text', text: 'x' }] }, manager());
  Send.startSend(s.id);
  core.setSetting('kill_switch', true);
  await Send.deliverBatch(Send.getSend(s.id));
  assert.equal(DB.one('SELECT COUNT(*) n FROM deliveries WHERE send_id = ?', s.id).n, 0);
  core.setSetting('kill_switch', false);
});

test('hard bounce webhook suppresses the address', () => {
  const d = DB.one('SELECT * FROM deliveries WHERE esp_message_id IS NOT NULL LIMIT 1');
  Esp.processEspEvent({ id: 'b-1', type: 'bounced', bounce_type: 'hard', message_id: d.esp_message_id });
  assert.ok(A.isSuppressed(d.email));
  assert.equal(Esp.processEspEvent({ id: 'b-1', type: 'bounced', bounce_type: 'hard', message_id: d.esp_message_id }), false, 'duplicate webhook ignored');
});

test('small numbers are hidden for aggregate-only views', () => {
  const out = M.suppressSmall({ channels: [{ leads: 2, enrolled: 1, hired: 0, cost_per_enrolled: 50000, spend: 100000 }, { leads: 30, enrolled: 5, cost_per_enrolled: 20000 }] });
  assert.equal(out.channels[0].leads, 'fewer than 3');
  assert.equal(out.channels[0].enrolled, 'fewer than 3');
  assert.equal(out.channels[0].hired, 0);
  assert.equal(out.channels[0].cost_per_enrolled, null);
  assert.equal(out.channels[1].enrolled, 5);
});

test('Event Hub contract: validated, idempotent, creates contact with consent and touchpoint', () => {
  assert.throws(() => EH.ingestMessage({ id: 'x', type: 'event.deleted', version: '1.0', data: {} }), /Unknown type/);
  assert.throws(() => EH.ingestMessage({ id: 'y', type: 'event.created', version: '2.0', data: {} }), /Unsupported contract version/);
  EH.ingestMessage({ id: 'm1', type: 'event.created', version: '1.0', data: { event_id: 'E1', title: 'Open day', type: 'open_day', starts_at: '2026-11-20T10:00:00.000Z', registration_url: 'https://x.test/e1' } });
  const r = EH.ingestMessage({ id: 'm2', type: 'registration.created', version: '1.0', data: { registration_id: 'R1', event_id: 'E1', email: 'guest@example.com', consent: { newsletter: true, events: true } } });
  assert.equal(r.status, 'processed');
  assert.equal(EH.ingestMessage({ id: 'm2', type: 'registration.created', version: '1.0', data: { registration_id: 'R1', event_id: 'E1', email: 'guest@example.com' } }).status, 'duplicate');
  const c = A.findByEmail('guest@example.com');
  assert.equal(A.consentState(c.id, 'newsletter'), 'granted');
  assert.equal(DB.one(`SELECT wording_version FROM consent_records WHERE contact_id = ? AND topic = 'newsletter'`, c.id).wording_version, A.CURRENT_WORDING);
  EH.ingestMessage({ id: 'm3', type: 'checkin.recorded', version: '1.0', data: { registration_id: 'R1', checked_in_at: '2026-11-20T10:30:00.000Z' } });
  assert.equal(DB.one(`SELECT COUNT(*) n FROM touchpoints WHERE contact_id = ? AND type = 'attendance'`, c.id).n, 1);
  EH.ingestMessage({ id: 'm4', type: 'event.cost_recorded', version: '1.0', data: { cost_id: 'C1', event_id: 'E1', amount: 50000, currency: 'AMD', category: 'venue' } });
  assert.equal(DB.one(`SELECT amount_amd FROM costs WHERE source_ref = 'event_hub:C1'`).amount_amd, 50000);
});

test('costs in foreign currency convert at the spend-date rate and keep the original', () => {
  Tax.setFxRate('USD', '2026-01-01', 390, null);
  Tax.addCost({ channel_id: Tax.channelBySlug('paid_search').id, date_from: '2026-02-01', date_to: '2026-02-28', amount: 100, currency: 'USD' }, manager());
  const c = DB.one(`SELECT * FROM costs WHERE original_currency = 'USD' ORDER BY id DESC LIMIT 1`);
  assert.equal(c.amount_amd, 39000); assert.equal(c.original_amount, 100); assert.equal(c.fx_rate, 390);
  // Prorated: half of February.
  assert.equal(Tax.costInRange({ from: '2026-02-01', to: '2026-02-14', channelId: c.channel_id }), 19500);
});

test('unknown utm pairs land in the review queue, never in a silent bucket', () => {
  assert.equal(Tax.mapUtm('tiktok', 'paid_social', 'test'), null);
  assert.ok(DB.one(`SELECT * FROM unmapped_values WHERE value = 'tiktok / paid_social'`));
  assert.equal(Tax.mapUtm('instagram', 'paid_social'), Tax.channelBySlug('paid_social').id);
});

test('role permissions follow the PRD matrix', () => {
  assert.ok(auth.can({ role: 'manager' }, 'send.approve'));
  assert.ok(!auth.can({ role: 'editor' }, 'send.approve'));
  assert.ok(!auth.can({ role: 'leadership' }, 'contacts.view'));
  assert.ok(auth.can({ role: 'leadership' }, 'dashboard.view'));
  assert.ok(!auth.can({ role: 'manager' }, 'integrations.manage'));
  assert.ok(auth.verifyPassword('correct horse battery', auth.hashPassword('correct horse battery')));
});

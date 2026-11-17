// Netlify runtime against an in-memory Netlify Blobs double: persistence across
// instances ("another computer"), concurrent writes, inline sending, schedules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshotFile = path.resolve(here, '../../netlify/generated/seed-snapshot.mjs');
process.env.MH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-sls-'));
process.env.NODE_ENV = 'test-serverless';

// Minimal Netlify Blobs double with ETags and conditional writes.
class MemoryStore {
  constructor() { this.items = new Map(); this.n = 0; this.writes = 0; }
  _put(key, data, metadata) { const etag = `"e${++this.n}"`; this.items.set(key, { data, etag, metadata }); this.writes++; return { modified: true, etag }; }
  async get(key, { type } = {}) {
    const it = this.items.get(key); if (!it) return null;
    if (type === 'json') return JSON.parse(Buffer.from(it.data).toString());
    if (type === 'arrayBuffer') return Buffer.from(it.data).buffer.slice(0);
    return Buffer.from(it.data).toString();
  }
  async getMetadata(key) { const it = this.items.get(key); return it ? { etag: it.etag, metadata: it.metadata || {} } : null; }
  async getWithMetadata(key) { const it = this.items.get(key); return it ? { data: Uint8Array.from(it.data).buffer, etag: it.etag, metadata: it.metadata || {} } : null; }
  async set(key, data, opts = {}) {
    const cur = this.items.get(key);
    if (opts.onlyIfNew && cur) return { modified: false };
    if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
    return this._put(key, Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data), opts.metadata);
  }
  async setJSON(key, v, opts) { return this.set(key, Buffer.from(JSON.stringify(v)), opts); }
  async delete(key) { this.items.delete(key); }
  latest() { return Math.max(...[...this.items.keys()].filter((k) => k.startsWith('db/v/')).map((k) => Number(k.slice(5)))); }
}

const store = new MemoryStore();
let R;
const B = 'https://pa-marketing-hub.netlify.app';
let cookie = '';
const call = async (method, p, body, extra = {}) => {
  const res = await R.handleRequest(new Request(B + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined }), { ip: '203.0.113.7' });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
};
// A different computer = a fresh function instance that only shares the Blobs store.
const newInstance = () => R._resetInstance();

before(async () => {
  assert.ok(fs.existsSync(snapshotFile), 'run scripts/build-netlify-seed.mjs first');
  R = await import('../src/serverless/runtime.js');
  R.setStoreFactory(async () => store);
  R.setSeedLoader(async () => Buffer.from((await import(pathToFileURL(snapshotFile).href)).default, 'base64'));
});
after(() => R._resetInstance());

test('first visit publishes the demo data and signs in', async () => {
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  const r = await call('POST', '/api/auth/login', { email: 'manager@academy.test', password: 'demo-password-2026' });
  assert.equal(r.status, 200);
  cookie = r.headers.getSetCookie()[0].split(';')[0];
  assert.match(r.headers.getSetCookie()[0], /Secure/i, 'cookie is Secure on https');
  assert.ok(store.items.has('db/v/1') && store.latest() >= 2, 'demo published as v1, sign-in saved a new version');
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.data.user.role, 'manager');
});

test('changes survive a restart and are visible from another computer', async () => {
  const s = await call('POST', '/api/segments', { name: 'Saved on computer A', rule: { match: 'all', conditions: [{ field: 'language', op: 'in', value: ['ru'] }] } });
  assert.equal(s.status, 200);
  newInstance();
  const list = await call('GET', '/api/segments');
  assert.ok(list.data.some((x) => x.name === 'Saved on computer A'), 'segment is there after a cold start');
  assert.equal((await call('GET', '/api/auth/me')).status, 200, 'session survives too');
});

test('reads do not write; writes are saved once', async () => {
  const w = store.writes; const v = store.latest();
  await call('GET', '/api/analytics/overview');
  await call('GET', '/api/contacts?page=1');
  assert.equal(store.writes, w, 'reads write nothing');
  await call('POST', '/api/email/seed-list', { email: 'qa-new@example.com' });
  assert.equal(store.latest(), v + 1, 'one write = one new version');
});

test('a concurrent write from someone else is not lost', async () => {
  // Someone on another computer saves a change after this instance loaded the data.
  await call('GET', '/api/segments');
  const v = store.latest();
  const f = path.join(os.tmpdir(), `mh-other-${Date.now()}.db`);
  fs.writeFileSync(f, zlib.gunzipSync(Buffer.from(await store.get(`db/v/${v}`, { type: 'arrayBuffer' }))));
  const other = new DatabaseSync(f);
  other.prepare(`INSERT INTO segments (name, rule, type, updated_at) VALUES ('Saved on computer B', '{"match":"all","conditions":[]}', 'dynamic', ?)`).run(new Date().toISOString());
  other.close();
  assert.equal((await store.set(`db/v/${v + 1}`, zlib.gzipSync(fs.readFileSync(f)), { onlyIfNew: true })).modified, true);
  // This instance still holds the old version and now writes. Make it try to save
  // version v+1 too (as if both saved at the same instant): it must lose and replay on B's data.
  const realGetMetadata = store.getMetadata.bind(store);
  let hidden = true;
  store.getMetadata = async (key) => (hidden && key === `db/v/${v + 1}` ? (hidden = false, null) : realGetMetadata(key));
  const mine = await call('POST', '/api/segments', { name: 'Saved on computer A again', rule: { match: 'all', conditions: [] } });
  store.getMetadata = realGetMetadata;
  assert.equal(mine.status, 200);
  newInstance();
  const names = (await call('GET', '/api/segments')).data.map((x) => x.name);
  assert.ok(names.includes('Saved on computer B'), 'the other computer’s change is kept');
  assert.ok(names.includes('Saved on computer A again'), 'this computer’s change is kept');
});

test('send now delivers inside the same call; unsubscribe link works', async () => {
  const issues = (await call('GET', '/api/newsletter/issues')).data;
  const en = issues.find((i) => i.language === 'en');
  assert.equal((await call('POST', `/api/newsletter/issues/${en.id}/approve`, { comment: 'ok' })).status, 200);
  const sch = await call('POST', `/api/newsletter/issues/${en.id}/schedule`, { at: new Date().toISOString() });
  assert.equal(sch.status, 200);
  const send = (await call('GET', `/api/sends/${sch.data.send_id}`)).data;
  assert.equal(send.status, 'sent');
  assert.ok(send.stats.delivered > 0, 'simulated provider events applied');
  newInstance();
  const out = (await call('GET', '/api/email/outbox?limit=1')).data[0];
  const msg = (await call('GET', `/api/email/outbox/${out.id}`)).data;
  assert.ok(msg.text.includes(B), 'links in emails use the site URL');
  const unsub = msg.headers['List-Unsubscribe'].match(/<(http[^>]+)>/)[1];
  const saved = cookie; cookie = '';
  const page = await R.handleRequest(new Request(unsub), {});
  assert.equal(page.status, 200);
  cookie = saved;
  newInstance();
  const c = (await call('GET', `/api/contacts?search=${encodeURIComponent(msg.to_email)}`)).data.rows[0];
  assert.equal(c.status, 'unsubscribed');
});

test('scheduled function runs periodic jobs and due sends', async () => {
  const r = await R.handleScheduled();
  assert.deepEqual(r, { ok: true });
});

test('public pages and uploads route through the function', async () => {
  const signup = await R.handleRequest(new Request(`${B}/signup?lang=hy`), {});
  assert.equal(signup.status, 200);
  assert.match(await signup.text(), /Picsart Academy/i);
});

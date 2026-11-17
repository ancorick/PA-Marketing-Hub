// Netlify runtime: no server to keep running, data shared by every user and device.
//
// Storage: the whole database is one gzip-compressed document in Netlify Blobs
// (Netlify's managed key-value store). Each function instance materializes it in
// /tmp and runs the unchanged application against it.
//
// Versions: every save creates a new immutable key `db/v/<n+1>` with
// `onlyIfNew`, so exactly one writer wins each version. Every request first
// checks whether a newer version exists (one metadata call, strong
// consistency), so a change made from another computer is visible on the next
// request. If someone else saved first, the request is replayed on their
// version, so concurrent edits are never lost.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const HEAD_KEY = 'db/head';
const versionKey = (n) => `db/v/${n}`;
const KEEP_VERSIONS = 20;
const CONFIG_KEY = 'config/runtime.json';
const MAX_ATTEMPTS = 6;

let storeFactory = async () => {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'marketing-hub', consistency: 'strong' });
};
let seedLoader = async () => { throw new Error('No seed snapshot configured'); };
export const setStoreFactory = (f) => { storeFactory = f; };
export const setSeedLoader = (f) => { seedLoader = f; };

let st = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootstrap(origin) {
  if (!st) {
    process.env.MH_SERVERLESS = '1';
    process.env.MH_DATA_DIR ||= path.join(os.tmpdir(), 'marketing-hub');
    const store = await storeFactory();
    // Secrets are generated once and kept in the store, so the site works without any manual setup.
    let rc = await store.get(CONFIG_KEY, { type: 'json' });
    if (!rc) {
      const fresh = {
        appSecret: crypto.randomBytes(32).toString('hex'), vaultKey: crypto.randomBytes(32).toString('hex'),
        espWebhookSecret: crypto.randomBytes(24).toString('hex'), eventHubSecret: crypto.randomBytes(24).toString('hex'),
        baseUrl: origin || null,
      };
      const w = await store.setJSON(CONFIG_KEY, fresh, { onlyIfNew: true });
      rc = w.modified ? fresh : await store.get(CONFIG_KEY, { type: 'json' });
    }
    process.env.MH_APP_SECRET ||= rc.appSecret;
    process.env.MH_VAULT_KEY ||= rc.vaultKey;
    process.env.MH_ESP_WEBHOOK_SECRET ||= rc.espWebhookSecret;
    process.env.MH_EVENT_HUB_SECRET ||= rc.eventHubSecret;
    if (origin && !rc.baseUrl) await store.setJSON(CONFIG_KEY, { ...rc, baseUrl: origin }).catch(() => {});
    process.env.MH_RUNTIME_ORIGIN = origin || rc.baseUrl || '';
    // Import the application only after the environment is set.
    const config = await import('../config.js');
    const db = await import('../db.js');
    const jobs = await import('../jobs.js');
    const { createApp } = await import('../app.js');
    st = { store, version: 0, loaded: 0, config, db, jobs, createApp, server: null, port: null };
  }
  if (origin) process.env.MH_RUNTIME_ORIGIN = origin;
  return st;
}

const dbFile = () => st.config.config.dbFile;

// Find the newest version: start from what this instance knows (or the head hint)
// and step forward while a next version exists. Usually a single metadata call.
async function latestVersion() {
  let v = st.version;
  if (!v) v = Number((await st.store.get(HEAD_KEY, { type: 'json' }))?.v || 0);
  if (!v) {
    if (!(await st.store.getMetadata(versionKey(1)))) {
      // First visit ever: publish the demo snapshot built during the Netlify build.
      await st.store.set(versionKey(1), await seedLoader(), { onlyIfNew: true, metadata: { savedAt: new Date().toISOString() } });
      await st.store.setJSON(HEAD_KEY, { v: 1 }).catch(() => {});
    }
    v = 1;
  }
  while (await st.store.getMetadata(versionKey(v + 1))) v++;
  return v;
}

async function ensureDb() {
  const v = await latestVersion();
  if (v === st.loaded && st.db.db) return;
  const data = await st.store.get(versionKey(v), { type: 'arrayBuffer' });
  if (!data) throw new Error(`Snapshot ${v} is missing`);
  const bytes = zlib.gunzipSync(Buffer.from(data));
  st.db.closeDb();
  fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
  for (const f of [`${dbFile()}-journal`, `${dbFile()}-wal`, `${dbFile()}-shm`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(dbFile(), bytes);
  st.db.openDb(dbFile());
  st.version = st.loaded = v;
}

async function persist() {
  const next = st.loaded + 1;
  const gz = zlib.gzipSync(fs.readFileSync(dbFile()), { level: 6 });
  const w = await st.store.set(versionKey(next), gz, { onlyIfNew: true, metadata: { savedAt: new Date().toISOString() } });
  if (!w.modified) return false; // someone else saved version `next` first
  st.version = st.loaded = next;
  await st.store.setJSON(HEAD_KEY, { v: next }).catch(() => {});
  // Keep a short history of snapshots (also a cheap undo for administrators).
  if (next > KEEP_VERSIONS) await st.store.delete(versionKey(next - KEEP_VERSIONS)).catch(() => {});
  return true;
}

/** Run `work` against fresh data; save if it wrote; replay on a concurrent write. */
async function withDb(work, { drainMs = 0 } = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await ensureDb();
    const before = st.db.totalChanges();
    const result = await work();
    // "Send now" and due schedules are delivered inside the same call.
    if (drainMs) await st.jobs.drainSends(drainMs);
    if (st.db.totalChanges() === before) return result;
    if (await persist()) return result;
    st.loaded = 0; // someone saved first: reload their version and redo this request
    await sleep(80 * (attempt + 1) + Math.random() * 120);
  }
  throw new Error('Too many concurrent changes; please retry');
}

async function ensureServer() {
  if (st.server) return;
  const app = st.createApp();
  // No keep-alive on the internal hop: a frozen/thawed instance must never reuse a dead socket.
  const server = http.createServer((req, res) => { res.setHeader('Connection', 'close'); app(req, res); });
  await new Promise((resolve) => { st.server = server.listen(0, '127.0.0.1', resolve); });
  st.port = st.server.address().port;
}

const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'host', 'accept-encoding'];
async function forward(req, body, ip) {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  for (const h of HOP) headers.delete(h);
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  if (ip) headers.set('x-forwarded-for', ip);
  const r = await fetch(`http://127.0.0.1:${st.port}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: 'manual' });
  const out = new Headers(r.headers);
  for (const h of HOP) out.delete(h);
  return { status: r.status, headers: out, body: await r.arrayBuffer() };
}

export async function handleRequest(req, context = {}) {
  try {
    await bootstrap(new URL(req.url).origin);
    await ensureServer();
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.from(await req.arrayBuffer());
    const res = await withDb(() => forward(req, body, context.ip), { drainMs: 4000 });
    return new Response([204, 304].includes(res.status) || req.method === 'HEAD' ? null : res.body, { status: res.status, headers: res.headers });
  } catch (e) {
    console.error('marketing-hub function error', e);
    return Response.json({ error: e.message === 'Too many concurrent changes; please retry' ? e.message : 'Something went wrong on our side. The error was logged.' }, { status: 503 });
  }
}

/** Scheduled function: periodic jobs (newsletter drafts, pipeline, sunset) and due sends. */
export async function handleScheduled() {
  await bootstrap(null);
  return withDb(async () => {
    await st.jobs.runPeriodicJobs();
    await st.jobs.drainSends(18000);
    return { ok: true };
  });
}

// Test helper: forget the in-memory instance (simulates a different function instance / computer).
export function _resetInstance() {
  if (st?.server) st.server.close();
  if (st) st.db.closeDb();
  st = null;
}

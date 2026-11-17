// Central configuration. Every secret comes from the environment (PRD NFR-S3);
// development defaults are generated and stored in data/.secrets.json so the
// app runs out of the box, but they are never committed or logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
// Serverless (Netlify Functions): the database lives in Netlify Blobs and is
// materialized in /tmp per function instance; see src/serverless/runtime.js.
export const SERVERLESS = process.env.MH_SERVERLESS === '1';
export const DATA_DIR = process.env.MH_DATA_DIR || (SERVERLESS ? '/tmp/marketing-hub' : path.join(ROOT, 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadDevSecrets() {
  const file = path.join(DATA_DIR, '.secrets.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const secrets = {
    appSecret: crypto.randomBytes(32).toString('hex'),
    vaultKey: crypto.randomBytes(32).toString('hex'),
    espWebhookSecret: crypto.randomBytes(24).toString('hex'),
    eventHubSecret: crypto.randomBytes(24).toString('hex'),
  };
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}
const dev = loadDevSecrets();

export const config = {
  port: Number(process.env.PORT || 4000),
  // A getter: on Netlify the public URL is learned from the first request.
  get baseUrl() { return process.env.MH_BASE_URL || process.env.URL || process.env.MH_RUNTIME_ORIGIN || `http://localhost:${process.env.PORT || 4000}`; },
  serverless: SERVERLESS,
  dbFile: process.env.MH_DB_FILE || path.join(DATA_DIR, 'marketing-hub.db'),
  env: process.env.NODE_ENV || 'development',
  // HMAC key for unsubscribe / preferences / tracking tokens (NFR-S5).
  appSecret: process.env.MH_APP_SECRET || dev.appSecret,
  // AES-256-GCM key for stored integration credentials ("secrets manager", EML-01).
  vaultKey: process.env.MH_VAULT_KEY || dev.vaultKey,
  espWebhookSecret: process.env.MH_ESP_WEBHOOK_SECRET || dev.espWebhookSecret,
  eventHubSecret: process.env.MH_EVENT_HUB_SECRET || dev.eventHubSecret,
  // Email service provider adapter: "dev" (local outbox + simulated webhooks) or "smtp".
  espAdapter: process.env.MH_ESP_ADAPTER || 'dev',
  smtp: {
    host: process.env.MH_SMTP_HOST,
    port: Number(process.env.MH_SMTP_PORT || 587),
    user: process.env.MH_SMTP_USER,
    pass: process.env.MH_SMTP_PASS,
  },
  slackWebhookUrl: process.env.MH_SLACK_WEBHOOK_URL || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.MH_AI_MODEL || 'claude-opus-5-5',
  academy: {
    name: 'Picsart Academy',
    address: process.env.MH_ACADEMY_ADDRESS || 'Academy campus, Yerevan, Armenia',
    domain: process.env.MH_ACADEMY_DOMAIN || 'academy-domain.am',
  },
  // How often background jobs tick (ms).
  workerTickMs: Number(process.env.MH_WORKER_TICK_MS || 5000),
};

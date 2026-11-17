// SQLite data layer (node:sqlite). Schema follows PRD section 12 (data model).
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export let db;

export function openDb(file = config.dbFile) {
  db = new DatabaseSync(file);
  // Serverless keeps the database as one file (no WAL) so it can be snapshotted to Netlify Blobs.
  // There the local file is only a cache: durability comes from the snapshot saved after each request,
  // so disk syncs are skipped.
  const serverless = process.env.MH_SERVERLESS === '1';
  db.exec(serverless
    ? 'PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON;'
    : 'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}
export function closeDb() { if (db) { try { db.close(); } catch { /* already closed */ } db = undefined; } }
// Rows changed on this connection since it was opened (used to detect writes).
export const totalChanges = () => db.prepare('SELECT total_changes() n').get().n;

export const now = () => new Date().toISOString();

export function q(sql, ...params) { return db.prepare(sql).all(...params); }
export function one(sql, ...params) { return db.prepare(sql).get(...params); }
export function run(sql, ...params) { return db.prepare(sql).run(...params); }

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const json = (v) => JSON.stringify(v ?? null);
export const parse = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

const SCHEMA = `
-- ---------- Staff, roles, audit (PRD 4.3, NFR-S8) ----------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','editor','manager','admin','leadership')),
  password_hash TEXT NOT NULL,
  ui_language TEXT NOT NULL DEFAULT 'en',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Mirrors the Core Engine activity log for every permission-sensitive action.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  actor_label TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  reason TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_activity_created ON activity_log(created_at);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Encrypted integration credentials (EML-01, NFR-S3).
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rotated_by INTEGER
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- ---------- Channel taxonomy (PRD 9.3) ----------
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  grp TEXT NOT NULL CHECK (grp IN ('paid','organic','owned','offline','referral')),
  utm_source TEXT,
  utm_medium TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS channel_rules (
  id INTEGER PRIMARY KEY,
  utm_source TEXT NOT NULL,
  utm_medium TEXT NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  UNIQUE (utm_source, utm_medium)
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  name TEXT NOT NULL,
  utm_campaign TEXT NOT NULL UNIQUE,
  start_date TEXT,
  end_date TEXT,
  budget_amd REAL,
  owner_id INTEGER,
  is_recruitment INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS short_links (
  code TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  campaign_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);

-- ---------- Audience (PRD 6, 12.1) ----------
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  rows_total INTEGER, rows_created INTEGER, rows_updated INTEGER, rows_invalid INTEGER,
  has_consent_column INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  core_person_id TEXT UNIQUE,
  email TEXT UNIQUE,
  email_cmp TEXT,
  phone TEXT,
  phone_norm TEXT,
  first_name TEXT,
  last_name TEXT,
  language TEXT NOT NULL DEFAULT 'hy' CHECK (language IN ('hy','en','ru')),
  type TEXT NOT NULL DEFAULT 'subscriber' CHECK (type IN ('subscriber','lead','applicant','student','alumnus')),
  course_family TEXT,
  source_channel_id INTEGER REFERENCES channels(id),
  source_campaign_id INTEGER REFERENCES campaigns(id),
  first_touch_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','unsubscribed','bounced','complained','erased')),
  tags TEXT NOT NULL DEFAULT '[]',
  frequency TEXT NOT NULL DEFAULT 'monthly',
  engagement TEXT NOT NULL DEFAULT 'normal',
  employment_status TEXT,
  referred_enrolled INTEGER NOT NULL DEFAULT 0,
  import_batch_id INTEGER REFERENCES import_batches(id),
  merged_into INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_contacts_cmp ON contacts(email_cmp);
CREATE INDEX IF NOT EXISTS ix_contacts_phone ON contacts(phone_norm);
CREATE INDEX IF NOT EXISTS ix_contacts_type ON contacts(type);
CREATE TABLE IF NOT EXISTS consent_wordings (
  version TEXT NOT NULL,
  topic TEXT NOT NULL,
  language TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (version, topic, language)
);
-- Append-only consent log; current state = latest row per topic (12.4).
CREATE TABLE IF NOT EXISTS consent_records (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  topic TEXT NOT NULL CHECK (topic IN ('newsletter','courses','events','alumni')),
  state TEXT NOT NULL CHECK (state IN ('granted','withdrawn','unknown','pending')),
  method TEXT NOT NULL CHECK (method IN ('form','event','import','manual','link','merge','complaint','erasure','sync','confirm')),
  wording_version TEXT,
  source_url TEXT,
  ip TEXT,
  actor_id INTEGER,
  reason TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_consent_contact ON consent_records(contact_id, topic, id);
-- Only redaction of personal fields (ip, source_url) is allowed, for erasure requests.
CREATE TRIGGER IF NOT EXISTS consent_no_update BEFORE UPDATE ON consent_records
  WHEN NEW.state IS NOT OLD.state OR NEW.topic IS NOT OLD.topic OR NEW.contact_id IS NOT OLD.contact_id
    OR NEW.method IS NOT OLD.method OR NEW.recorded_at IS NOT OLD.recorded_at
    OR (NEW.ip IS NOT NULL AND NEW.ip IS NOT OLD.ip)
    OR (NEW.source_url IS NOT NULL AND NEW.source_url IS NOT OLD.source_url)
  BEGIN SELECT RAISE(ABORT, 'consent_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_no_delete BEFORE DELETE ON consent_records
  BEGIN SELECT RAISE(ABORT, 'consent_records is append-only'); END;
-- Global suppression list; survives erasure (AUD-12, AUD-18).
CREATE TABLE IF NOT EXISTS suppression (
  id INTEGER PRIMARY KEY,
  email_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribed','hard_bounce','soft_bounce','complaint','erased','manual')),
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_suppression_hash ON suppression(email_hash);
CREATE TRIGGER IF NOT EXISTS suppression_no_update BEFORE UPDATE ON suppression
  BEGIN SELECT RAISE(ABORT, 'suppression is append-only'); END;
CREATE TRIGGER IF NOT EXISTS suppression_no_delete BEFORE DELETE ON suppression
  BEGIN SELECT RAISE(ABORT, 'suppression is append-only'); END;
CREATE TABLE IF NOT EXISTS merge_dismissals (
  a INTEGER NOT NULL, b INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rule TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'dynamic' CHECK (type IN ('dynamic','static')),
  owner_id INTEGER,
  last_count INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segment_members (
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  PRIMARY KEY (segment_id, contact_id)
);
CREATE TABLE IF NOT EXISTS export_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, what TEXT, segment_id INTEGER, row_count INTEGER, created_at TEXT NOT NULL
);

-- ---------- Touchpoints, costs, outcomes, attribution (9, 12.1) ----------
CREATE TABLE IF NOT EXISTS touchpoints (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  channel_id INTEGER REFERENCES channels(id),
  type TEXT NOT NULL CHECK (type IN ('visit','form','click','open','registration','attendance','chat','referral','lead')),
  occurred_at TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  UNIQUE (source_system, source_ref)
);
CREATE INDEX IF NOT EXISTS ix_touch_contact ON touchpoints(contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_touch_channel ON touchpoints(channel_id, occurred_at);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  amount_amd REAL NOT NULL,
  original_amount REAL NOT NULL,
  original_currency TEXT NOT NULL,
  fx_rate REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('api','manual','csv','event_hub')),
  source_ref TEXT UNIQUE,
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_costs_channel ON costs(channel_id, date_from);
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL, date TEXT NOT NULL, rate_amd REAL NOT NULL, PRIMARY KEY (currency, date)
);
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id),
  core_person_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('lead','applied','enrolled','completed','hired')),
  occurred_at TEXT NOT NULL,
  course_id TEXT,
  source_system TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  self_reported_channel_id INTEGER,
  UNIQUE (source_system, source_ref)
);
CREATE INDEX IF NOT EXISTS ix_outcomes_type ON outcomes(type, occurred_at);
CREATE INDEX IF NOT EXISTS ix_outcomes_contact ON outcomes(contact_id);
CREATE TABLE IF NOT EXISTS attribution_results (
  id INTEGER PRIMARY KEY,
  outcome_id INTEGER NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (model IN ('first_touch','last_touch','position_based')),
  channel_id INTEGER,
  campaign_id INTEGER,
  credit REAL NOT NULL,
  cohort_month TEXT,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attr_model ON attribution_results(model, channel_id);
CREATE INDEX IF NOT EXISTS ix_attr_outcome ON attribution_results(outcome_id);

-- ---------- Pipeline (12.3) ----------
CREATE TABLE IF NOT EXISTS raw_records (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  payload TEXT NOT NULL,
  pulled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_raw_source ON raw_records(source, window_from);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  window_from TEXT, window_to TEXT,
  rows_in INTEGER DEFAULT 0,
  rows_upserted INTEGER DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_sync_source ON sync_runs(source, id);
CREATE TABLE IF NOT EXISTS unmapped_values (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  resolved_channel_id INTEGER,
  UNIQUE (source, field, value)
);
CREATE TABLE IF NOT EXISTS web_traffic (
  date TEXT NOT NULL, channel_id INTEGER, utm_campaign TEXT, sessions INTEGER NOT NULL, conversions INTEGER NOT NULL,
  source_ref TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS social_stats (
  date TEXT NOT NULL, platform TEXT NOT NULL, reach INTEGER, engagement INTEGER, followers INTEGER, lead_forms INTEGER,
  source_ref TEXT PRIMARY KEY
);

-- ---------- Email sending layer (7, 12.2) ----------
CREATE TABLE IF NOT EXISTS sending_domains (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  from_name TEXT NOT NULL,
  tracking_domain TEXT NOT NULL,
  dkim_selector TEXT NOT NULL,
  spf_status TEXT NOT NULL DEFAULT 'unverified',
  dkim_status TEXT NOT NULL DEFAULT 'unverified',
  dmarc_status TEXT NOT NULL DEFAULT 'unverified',
  tracking_status TEXT NOT NULL DEFAULT 'unverified',
  dmarc_policy TEXT NOT NULL DEFAULT 'none',
  verification_mode TEXT NOT NULL DEFAULT 'dns',
  verified_at TEXT,
  last_check TEXT,
  warmup_started_at TEXT,
  stream TEXT NOT NULL DEFAULT 'marketing'
);
CREATE TABLE IF NOT EXISTS dmarc_reports (
  id INTEGER PRIMARY KEY,
  org TEXT, report_id TEXT, date_from TEXT, date_to TEXT, records TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'campaign',
  language TEXT NOT NULL DEFAULT 'en',
  brand TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'campaign' CHECK (kind IN ('campaign','newsletter','test','confirmation','reengagement','invitation')),
  name TEXT NOT NULL,
  campaign_id INTEGER REFERENCES campaigns(id),
  segment_id INTEGER REFERENCES segments(id),
  template_id INTEGER REFERENCES templates(id),
  domain_id INTEGER REFERENCES sending_domains(id),
  subject TEXT NOT NULL DEFAULT '',
  preheader TEXT,
  body TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  topic TEXT NOT NULL DEFAULT 'courses',
  exclude_active_applicants INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','scheduled','sending','paused','sent','cancelled')),
  scheduled_at TEXT,
  approved_by INTEGER,
  approved_at TEXT,
  approval_comment TEXT,
  started_at TEXT,
  finished_at TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  recipient_count INTEGER,
  pause_reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS send_queue (
  send_id INTEGER NOT NULL REFERENCES sends(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  priority REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (send_id, contact_id)
);
-- One row per (send, contact): the idempotency guarantee of EML-10.
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  send_id INTEGER NOT NULL REFERENCES sends(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  email TEXT NOT NULL,
  esp_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','bounced_soft','bounced_hard','complained','failed')),
  queued_at TEXT NOT NULL,
  delivered_at TEXT,
  opened_at TEXT,
  first_click_at TEXT,
  unsubscribed_at TEXT,
  error TEXT,
  UNIQUE (send_id, contact_id)
);
CREATE INDEX IF NOT EXISTS ix_deliveries_contact ON deliveries(contact_id);
CREATE INDEX IF NOT EXISTS ix_deliveries_msg ON deliveries(esp_message_id);
CREATE TABLE IF NOT EXISTS link_clicks (
  id INTEGER PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  block_id TEXT,
  url TEXT NOT NULL,
  clicked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS esp_outbox (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  to_email TEXT NOT NULL,
  from_header TEXT NOT NULL,
  subject TEXT NOT NULL,
  headers TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  idempotency_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS seed_list (
  email TEXT PRIMARY KEY, label TEXT
);

-- ---------- Newsletter (8, 12.2) ----------
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('hy','en','ru')),
  cut_off_at TEXT NOT NULL,
  planned_send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','draft','in_review','approved','scheduled','sent')),
  subject TEXT,
  preheader TEXT,
  subject_options TEXT,
  segment_id INTEGER REFERENCES segments(id),
  send_id INTEGER REFERENCES sends(id),
  archive_slug TEXT UNIQUE,
  approved_by INTEGER,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_blocks (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('lead','upcoming_events','recent_events','library','graduations','hires','new_groups','custom')),
  position INTEGER NOT NULL,
  title TEXT,
  source_items TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  image_alt TEXT,
  button_label TEXT,
  button_url TEXT,
  ai_drafted INTEGER NOT NULL DEFAULT 0,
  edited_by INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collected_items (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  occurred_at TEXT,
  score REAL NOT NULL DEFAULT 0,
  publishable INTEGER NOT NULL,
  skip_reason TEXT,
  data TEXT
);
CREATE TABLE IF NOT EXISTS issue_edits (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  block_id INTEGER,
  editor_id INTEGER,
  field TEXT,
  before TEXT,
  after TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_comments (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id INTEGER, body TEXT NOT NULL, created_at TEXT NOT NULL
);

-- ---------- Event Hub module (10) ----------
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  registration_url TEXT,
  language TEXT,
  recording_url TEXT,
  photos_url TEXT,
  media_public INTEGER NOT NULL DEFAULT 0,
  campaign_id INTEGER REFERENCES campaigns(id),
  source TEXT NOT NULL DEFAULT 'event_hub',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_registrations (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  contact_id INTEGER REFERENCES contacts(id),
  registered_at TEXT NOT NULL,
  cancelled_at TEXT,
  checked_in_at TEXT
);

-- ---------- Mock upstream systems ----------
-- These ext_* tables stand in for the other fellowship projects and external
-- services. Adapters read them exactly like an API page and land the response
-- in raw_records first (extract, load, then transform).
CREATE TABLE IF NOT EXISTS ext_core_people (
  person_id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT, phone TEXT, language TEXT,
  status TEXT, course TEXT, course_family TEXT, group_code TEXT, enrolled_at TEXT, graduated_at TEXT, completed INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_crm_leads (
  lead_id TEXT PRIMARY KEY, person_id TEXT, email TEXT, first_name TEXT, last_name TEXT, language TEXT, course_family TEXT,
  created_at TEXT, stage TEXT, applied_at TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  self_reported_source TEXT, origin TEXT, opt_in INTEGER DEFAULT 0, phone TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_alumni (
  person_id TEXT PRIMARY KEY, status TEXT, company TEXT, role TEXT, start_date TEXT, feature_consent INTEGER, referred_enrolled INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_library (
  id TEXT PRIMARY KEY, title TEXT, type TEXT, url TEXT, tags TEXT, is_public INTEGER, added_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_launchpad_groups (
  id TEXT PRIMARY KEY, course TEXT, course_family TEXT, start_date TEXT, open_for_applications INTEGER, seats INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_graduations (
  id TEXT PRIMARY KEY, course TEXT, group_code TEXT, graduates INTEGER, graduated_at TEXT
);
CREATE TABLE IF NOT EXISTS ext_web_identified (
  id TEXT PRIMARY KEY, email TEXT, occurred_at TEXT, type TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT
);
CREATE TABLE IF NOT EXISTS ext_web_sessions (
  id TEXT PRIMARY KEY, date TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, sessions INTEGER, conversions INTEGER
);
CREATE TABLE IF NOT EXISTS ext_social_posts (
  id TEXT PRIMARY KEY, date TEXT, platform TEXT, reach INTEGER, engagement INTEGER, followers INTEGER, lead_forms INTEGER
);
CREATE TABLE IF NOT EXISTS ext_ad_spend (
  id TEXT PRIMARY KEY, date TEXT, platform TEXT, utm_campaign TEXT, spend REAL, currency TEXT, impressions INTEGER, clicks INTEGER, leads INTEGER
);
`;

function migrate() {
  db.exec(SCHEMA);
}

# Marketing Hub

Marketing Hub (Project 12 of the Student Fellowship Program) gives the Academy's marketing team one contact base, its own authenticated email sending, a newsletter that drafts itself, and one dashboard that answers a single question: **which channel brings students who enroll, finish the course and get hired?**

It is built from the *Marketing Hub — Product Requirements Document* and keeps every concept in it: the four modules (Audience, Newsletter, Analytics, Event Hub as the fourth), the shared email sending layer, consent and suppression rules, ELT pipelines with a raw layer, three attribution models, cohort view, guardrails, roles and the activity log.

## Quick start

Requirements: Node.js 22.13 or later (uses the built-in `node:sqlite`). Nothing else: no database server, no native modules.

```bash
npm run install:all      # server + client dependencies
npm run build            # builds the React app into client/dist
npm run seed             # demo data: ~18 months of leads, students, events, spend, newsletters
npm start                # http://localhost:4000
```

For development with hot reload, run `npm run dev:server` and `npm run dev:client` (Vite on http://localhost:5173, proxying the API).

`npm test` runs the core rule tests (22 tests: consent precedence, suppression, merge, erasure, injection-safe segments, attribution, idempotent sending, kill switch, Event Hub contract, FX, roles).

### Demo accounts

Password for all: `demo-password-2026` (development only).

| Account | Role | What it can do |
| --- | --- | --- |
| manager@academy.test | Marketing manager | Everything marketing: approve and schedule sends, costs, manual consent changes, exports |
| editor@academy.test | Editor | Contacts, segments, newsletter and campaign drafts; cannot approve or send |
| admin@academy.test | Admin | Domains, DNS, API keys, credentials, users and roles |
| director@academy.test | Leadership | Aggregates only; counts under 3 are hidden |
| viewer@academy.test | Viewer | Dashboard only |

Demo API keys (Command Center, Event Hub) and webhook secrets are written to `server/data/demo-keys.txt` by the seed.

### Things to try

1. **Overview**: switch attribution model and Period/Cohort view; open a channel and a campaign.
2. **Newsletter**: open next month's draft, swap items, see skipped items and why, approve, schedule, then watch the **Dev inbox** and the issue **Report**.
3. **Dev inbox**: open an email, follow the unsubscribe or preferences link from the plain-text view; the contact is suppressed within a second.
4. **Public sign-up** (`/signup?lang=hy`): sign up, confirm via the Dev inbox, find the contact with its source channel and consent wording version.
5. **Data health**: simulate a failing source twice to see the alert; map an unmapped `tiktok / paid_social` tag and watch attribution recompute.
6. **Email settings**: kill switch, DNS records, DMARC policy steps, guardrails, sunset policy.
7. Sign in as **director@** to see the aggregate-only view.

## Deploy to Netlify (no server to run)

The repository deploys to Netlify as is. There is no server to keep running and nothing to configure: open the site, change things, come back days later from another computer, and everything is there for every user.

1. app.netlify.com → **Add new site → Import an existing project → GitHub** → this repository.
2. Leave the build settings as they are (they come from `netlify.toml`) → **Deploy**.
3. Open the site and sign in with a demo account. The first visit publishes the demo data.

Every `git push` to `main` redeploys automatically. Redeploys never reset live data.

How it works:

- The React app is static. The API and the public pages (unsubscribe, preferences, sign-up, tracking, archive) run in one Netlify Function (`netlify/functions/api.mjs`); a scheduled function (`worker.mjs`, every 5 minutes) delivers scheduled sends and runs the newsletter, pipeline and sunset jobs.
- Data lives in **Netlify Blobs**, Netlify's managed key-value (NoSQL) store. The whole database is one compressed snapshot; each save writes a new immutable version (`db/v/<n>`) with `onlyIfNew`, so exactly one writer wins each version. Every request first checks for a newer version, so changes from other users and computers are visible immediately. When two people save at the same moment, the second request is replayed on the first one's data, so no change is lost. The last 20 versions are kept.
- Secrets (token signing, credential encryption, webhook secrets) are generated on first run and stored in Blobs. You can override them with environment variables in the Netlify UI.
- The Netlify build uses a lighter demo profile (half the volume, 6 months of newsletter history) to keep each save small (about 1.5 MB compressed).

Limits of this mode: it suits a team of up to a few dozen staff users; every save uploads the full snapshot, so heavy simultaneous editing by many people slows saves down. "Send now" delivers within the same request (a few hundred emails); larger sends continue in the scheduled function. Scheduled functions run only on the published production deploy.

## Architecture

```
client/  React 18 + Vite SPA (staff interface, English and Armenian)
server/  Node.js + Express, SQLite via node:sqlite
  src/services/audience.js         contacts, consent (append-only), suppression, dedup/merge, import, erasure
  src/services/segments.js         whitelisted JSON rule engine compiled to parameterized SQL
  src/services/email/render.js     600px responsive HTML + plain text, footer, tracking, List-Unsubscribe
  src/services/email/sending.js    drafts, checks, approval, schedule, idempotent batches, warm-up, guardrails, kill switch, reports, sunset
  src/services/email/esp.js        ESP adapters (dev outbox with simulated signed webhooks, SMTP) and webhook processing
  src/services/email/domains.js    SPF/DKIM/DMARC records, live DNS checks, DMARC report parsing, address validation
  src/services/newsletter.js       collectors, ranking, auto-drafts, block editing with edit log, approval, schedule, archive, report
  src/services/ai.js               optional AI writing assist (Claude API), clearly marked until a person accepts it
  src/services/analytics/          taxonomy + link builder + FX + costs, ELT pipeline + raw layer, attribution, metrics
  src/services/eventhub.js         Event Hub contract v1.0 (signed, idempotent), sandbox, manual fallback
  src/routes/public.js             no-login pages: unsubscribe, preferences, double opt-in, sign-up, archive, tracking, privacy
  src/seed/                        demo data through the real pipeline and the real Event Hub contract
```

Upstream systems (Core Engine, Navigator CRM, Alumni Tracker, Library, Group Launchpad, GA4, Meta, Google Ads) are simulated in `ext_*` tables. Each pipeline adapter reads them exactly like an API page, lands the unchanged response in `raw_records`, then transforms it. Replacing a simulated source with the real API means replacing one adapter's `pull()`; nothing else changes.

## Configuration

All secrets come from the environment; development defaults are generated into `server/data/.secrets.json`.

| Variable | Purpose |
| --- | --- |
| `PORT`, `MH_BASE_URL` | Port and public base URL (used in links inside emails) |
| `MH_APP_SECRET` | HMAC key for unsubscribe, preferences and tracking tokens |
| `MH_VAULT_KEY` | 32-byte hex AES-256-GCM key for stored integration credentials |
| `MH_ESP_ADAPTER` | `dev` (local outbox + simulated webhooks) or `smtp` |
| `MH_SMTP_HOST`, `MH_SMTP_PORT`, `MH_SMTP_USER`, `MH_SMTP_PASS` | SMTP relay for the `smtp` adapter |
| `MH_ESP_WEBHOOK_SECRET`, `MH_EVENT_HUB_SECRET` | Webhook signing secrets |
| `MH_SLACK_WEBHOOK_URL` | Alerts and "draft ready" notices to Slack |
| `ANTHROPIC_API_KEY`, `MH_AI_MODEL` | Optional AI writing assist (default model `claude-opus-5-5`, with server-side refusal fallback) |
| `MH_ACADEMY_DOMAIN`, `MH_ACADEMY_ADDRESS` | Sending domain root and the physical address in every footer |

## PRD coverage

| PRD | Where |
| --- | --- |
| AUD-01..20 (contact base, dedup, merge, consent, double opt-in, one-click unsubscribe, List-Unsubscribe, preferences, suppression, segments, static lists, timeline, applicant exclusion, erasure, export log, sign-up endpoint) | `services/audience.js`, `services/segments.js`, `routes/public.js`; Contacts, Import, Duplicates, Segments pages |
| EML-01..16 (ESP via adapter, DNS setup and verification, blocked unauthenticated sends, signed webhooks, bounces, complaints, DMARC reports, warm-up, batching, idempotency, HTML + text with footer, validation, test sends, kill switch, sunset, send log) | `services/email/*`; Email settings, Campaign emails, Dev inbox |
| 7.4 guardrails | `evaluateGuardrails()` in `sending.js`; provider warning pauses all sends |
| NWS-01..17 (cadence, collectors, auto-draft, notifications, block editor, three languages, AI assist, preview, checks, approval, send, archive, report, UTM tagging, templates, edit log) | `services/newsletter.js`, `services/ai.js`; Newsletter pages |
| ANL-01..16 (pulls with raw layer, idempotent incremental windows, taxonomy and unmapped queue, link builder, costs, attribution models, Overview, channel/campaign/cohort views, maturing cohorts, Data health with alerts, CSV/PDF export, Command Center API, small-number suppression, definitions, self-reported check) | `services/analytics/*`, `routes/integrations.js`; Overview, Cohorts, Costs, Campaigns & links, Data health |
| EVT-01..08 (contract, six message types, contacts with consent, touchpoints, events view, newsletter feed, invitation segments + suppression API, sandbox) and 10.5 fallback | `services/eventhub.js`, `docs/event-hub-contract.md`; Events page |
| 4.3 roles and permissions, NFR-S1..S9, NFR-P1..P7 | `lib/auth.js`, `lib/http.js`, `lib/core.js` (activity log, vault); Admin page; `/privacy` |
| 12 data model | `server/src/db.js` |
| 13 user flows A–E | End-to-end tested against the running server |

## Production notes

- Point `MH_ESP_ADAPTER=smtp` (or add an adapter for the chosen ESP's HTTP API in `esp.js`) and set the ESP's webhook URL to `/api/webhooks/esp` with the signing secret.
- Create the sending subdomain in **Email settings**, publish the four DNS records, press **Check DNS now**, then follow the DMARC steps (none → quarantine → reject).
- Replace simulated `ext_*` reads with real API calls inside each adapter's `pull()`; keep the raw layer.
- Staff sign-in should delegate to the Core Engine; `lib/auth.js` keeps the same interface.
- See `docs/runbook.md` for daily operations.

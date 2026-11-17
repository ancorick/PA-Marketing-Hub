// Machine-to-machine endpoints: signed webhooks (raw body for signature checks),
// the Event Hub contract and sandbox (10.3, EVT-01..08) and the Command Center API (ANL-13).
import express from 'express';
import { one } from '../db.js';
import { bad } from '../lib/util.js';
import { requireApiKey } from '../lib/auth.js';
import { rateLimit } from '../lib/http.js';
import { handleEspWebhook } from '../services/email/esp.js';
import { handleEventHubWebhook, validateMessage, suppressionStatus, CONTRACT_VERSION, EVENT_TYPES } from '../services/eventhub.js';
import { segmentContactIds } from '../services/segments.js';
import { isSuppressed, consentState } from '../services/audience.js';
import { overview, suppressSmall, cohorts } from '../services/analytics/metrics.js';

export const router = express.Router();
const raw = express.raw({ type: '*/*', limit: '2mb' });
const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

router.post('/webhooks/esp', rateLimit({ windowMs: 1000, max: 500 }), raw, (req, res) => {
  res.json(handleEspWebhook(req.body.toString('utf8'), lower(req.headers)));
});

router.post('/integrations/event-hub', rateLimit({ windowMs: 1000, max: 200 }), raw, (req, res) => {
  res.json(handleEventHubWebhook(req.body.toString('utf8'), lower(req.headers)));
});

// EVT-08: validates a message against the contract and reports what would happen; writes nothing.
router.post('/integrations/event-hub/sandbox', rateLimit({ windowMs: 60_000, max: 120 }), raw, (req, res) => {
  let msg;
  try { msg = JSON.parse(req.body.toString('utf8')); } catch { throw bad('Body is not valid JSON'); }
  const messages = Array.isArray(msg) ? msg : [msg];
  const results = messages.map((m) => {
    try {
      validateMessage(m);
      const dup = one('SELECT 1 FROM webhook_events WHERE idempotency_key = ?', `event_hub:${m.id}`);
      return { id: m.id, valid: true, would: dup ? 'be ignored as a duplicate' : `be processed as ${m.type}` };
    } catch (e) { return { id: m?.id ?? null, valid: false, error: e.message }; }
  });
  res.json({ contract_version: CONTRACT_VERSION, event_types: EVENT_TYPES, results });
});

// EVT-07: Event Hub checks suppression and pulls invitation segments (API key, scope event_hub).
router.get('/integrations/event-hub/suppression', requireApiKey('event_hub'), (req, res) => res.json(suppressionStatus(String(req.query.email || ''))));
router.get('/integrations/event-hub/segments/:id/contacts', requireApiKey('event_hub'), (req, res) => {
  const rows = segmentContactIds(Number(req.params.id))
    .map((cid) => one(`SELECT id, email, first_name, last_name, language, status FROM contacts WHERE id = ?`, cid))
    .filter((c) => c?.email && c.status === 'active' && !isSuppressed(c.email) && consentState(c.id, 'events') === 'granted');
  res.json({ segment_id: Number(req.params.id), contacts: rows.map(({ status, ...c }) => c) });
});

// ANL-13: aggregate metrics for Command Center, small numbers suppressed.
router.get('/v1/metrics/overview', requireApiKey('command_center'), (req, res) => {
  const o = overview({ from: req.query.from, to: req.query.to, model: req.query.model || 'first_touch' });
  res.json(suppressSmall({ range: o.range, model: o.model, tiles: o.tiles, channels: o.channels, totals: o.totals, coverage: o.coverage }));
});
router.get('/v1/metrics/cohorts', requireApiKey('command_center'), (req, res) => res.json(suppressSmall(cohorts({ model: req.query.model || 'first_touch' }))));

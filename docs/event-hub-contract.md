# Event Hub → Marketing Hub contract, v1.0

Event Hub (Project 13) plugs into Marketing Hub as its fourth module. This contract lets the two teams build independently.

## Transport

- `POST {base}/api/integrations/event-hub` with a JSON body: one message or an array of messages.
- Headers:
  - `X-EventHub-Timestamp`: Unix time in seconds.
  - `X-EventHub-Signature`: hex HMAC-SHA256 of `"<timestamp>.<raw body>"` with the shared secret.
- Messages older than 5 minutes, or with a wrong signature, are rejected with `401`.
- Every message has a unique `id`. Marketing Hub processes each `id` once; a repeat returns `"status": "duplicate"`.
- Sandbox: `POST {base}/api/integrations/event-hub/sandbox` validates messages and reports what would happen, writing nothing (no signature needed).

## Envelope

```json
{ "id": "msg-0001", "type": "registration.created", "version": "1.0", "occurred_at": "2026-11-20T10:00:00Z", "data": { } }
```

## Message types

| type | required `data` fields | optional |
| --- | --- | --- |
| `event.created` / `event.updated` | `event_id`, `title`, `type`, `starts_at` | `public` (default true), `registration_url`, `language`, `recording_url`, `photos_url`, `media_public` |
| `registration.created` | `registration_id`, `event_id`, `email` | `first_name`, `last_name`, `phone`, `language`, `core_person_id`, `consent` (`{"newsletter": true, "events": true}`), `consent_wording_version`, `registered_at`, `utm` (`utm_source`, `utm_medium`, `utm_campaign` of the registration link) |
| `registration.cancelled` | `registration_id` | `cancelled_at` |
| `checkin.recorded` | `registration_id`, `checked_in_at` | |
| `event.cost_recorded` | `cost_id`, `event_id`, `amount`, `currency`, `category` | `note` |

## What Marketing Hub does with them

- Events become campaigns under the **Events and open days** channel (`utm_campaign = event_<event_id>`).
- A registration creates or updates the contact (matched by Core Engine person id, then email), records consent with the wording version shown on the form, and records a `registration` touchpoint. If the registration link carried campaign parameters, those win for attribution.
- A check-in records an `attendance` touchpoint.
- Costs are converted to AMD at the spend-date rate and count as channel and event cost.
- Public upcoming events with a registration URL, and recordings or photos marked public, feed the newsletter.

## Calls Event Hub can make (API key with scope `event_hub`, header `X-Api-Key`)

- `GET /api/integrations/event-hub/suppression?email=…` → `{ "suppressed": true|false }`. Event Hub never sends promotional mail to a suppressed address. Confirmations and reminders for an event are transactional and stay with Event Hub.
- `GET /api/integrations/event-hub/segments/{id}/contacts` → contacts in a segment who are active, not suppressed and consented to `events` (for invitations).

## Example (signing in Node.js)

```js
const body = JSON.stringify(message);
const ts = Math.floor(Date.now() / 1000);
const signature = crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
await fetch(`${BASE}/api/integrations/event-hub`, { method: 'POST', body,
  headers: { 'content-type': 'application/json', 'X-EventHub-Timestamp': String(ts), 'X-EventHub-Signature': signature } });
```

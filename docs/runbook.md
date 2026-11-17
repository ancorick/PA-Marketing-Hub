# Marketing Hub runbook

## Pause all sending

Email settings → **Kill switch**. Every send stops within one worker tick (about 5 seconds). Resume from the red banner or the same button. The action is in the activity log.

A single send: open it under Campaign emails → **Pause**. Guardrails pause sends by themselves when, in the first 1,000 messages, hard bounces pass 5%, or when complaints pass 0.3%; an alert names the reason. Fix the cause (usually a bad list), then **Resume** or **Cancel**.

## Set up a sending domain

1. Email settings → **Add domain** (use a dedicated subdomain such as `news.<academy domain>`).
2. Publish the SPF, DKIM, DMARC and tracking records exactly as listed.
3. **Check DNS now**. Marketing sends are blocked until SPF, DKIM and DMARC verify.
4. Warm-up starts automatically with the most engaged contacts; daily caps are under Guardrails.
5. DMARC: start at `p=none`; after two clean weeks of reports move to `quarantine`, then `reject`.

## Rotate credentials

- Integration credentials: Admin → Integrations & keys → **Save / rotate**. Stored encrypted; no restart needed.
- DKIM: Email settings → **Rotate DKIM**, publish the new selector record, check DNS. Rotate at least yearly.
- API keys: create a new key, update the client, revoke the old one.
- `MH_APP_SECRET` rotation invalidates existing unsubscribe links in sent emails; avoid it unless the secret leaked.

## Re-run or rebuild data

- Data health → **Re-run** a source (pulls the last window again with a 2-day overlap; safe to repeat).
- **Replay raw** rebuilds clean tables from stored raw responses after a taxonomy or logic change, then recomputes attribution.
- A source that fails twice in a row raises a critical alert (and posts to Slack when configured).
- Unmapped campaign tags appear under Data health; map them to a channel and attribution recomputes.

## Requests from people

- **Unsubscribe by reply or phone**: open the contact → **Unsubscribe** (logged).
- **Access request**: contact → **Export data** (JSON, logged in the export log). Answer within 30 days.
- **Erasure**: contact → **Erase**. Personal fields are removed, an anonymized row stays for aggregates, and the hashed address stays suppressed.

## Imports

Always preview first. Rows without consent import as *unknown consent* and are never mailed until they confirm. An import whose first send bounces above 10% is blocked; a manager reviews and unblocks it under Contacts → Import.

## Backups

The database is one SQLite file (`server/data/marketing-hub.db`, WAL mode). Back it up daily with `sqlite3 marketing-hub.db ".backup backup.db"` (or copy while the server is stopped), encrypt the copy, and test a restore at least once per milestone. Uploaded images live in `server/data/uploads/`.

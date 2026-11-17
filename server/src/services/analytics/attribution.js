// Attribution (9.4, ANL-06, ANL-07, ANL-16).
// first_touch: 100% to the first recorded channel in the lookback window.
// last_touch: 100% to the last channel before the application date.
// position_based: 40% first, 40% last, 20% split across the middle.
// Lookback: 365 days before the application (or before the lead date for leads).
import { q, run, now, tx } from '../../db.js';
import { getSetting } from '../../lib/core.js';
import { monthOf } from '../../lib/util.js';

export const MODELS = ['first_touch', 'last_touch', 'position_based'];

/** Pure function, unit-tested: touches sorted by time -> [{channel_id, campaign_id, credit}] */
export function creditTouches(touches, model) {
  if (!touches.length) return [{ channel_id: null, campaign_id: null, credit: 1 }];
  const first = touches[0]; const last = touches[touches.length - 1];
  if (model === 'first_touch') return [{ channel_id: first.channel_id, campaign_id: first.campaign_id, credit: 1 }];
  if (model === 'last_touch') return [{ channel_id: last.channel_id, campaign_id: last.campaign_id, credit: 1 }];
  if (touches.length === 1) return [{ channel_id: first.channel_id, campaign_id: first.campaign_id, credit: 1 }];
  if (touches.length === 2) return [
    { channel_id: first.channel_id, campaign_id: first.campaign_id, credit: 0.5 },
    { channel_id: last.channel_id, campaign_id: last.campaign_id, credit: 0.5 },
  ];
  const middle = touches.slice(1, -1);
  const each = 0.2 / middle.length;
  const parts = [
    { channel_id: first.channel_id, campaign_id: first.campaign_id, credit: 0.4 },
    ...middle.map((t) => ({ channel_id: t.channel_id, campaign_id: t.campaign_id, credit: each })),
    { channel_id: last.channel_id, campaign_id: last.campaign_id, credit: 0.4 },
  ];
  // Merge credit that lands on the same channel+campaign.
  const merged = new Map();
  for (const p of parts) {
    const k = `${p.channel_id}:${p.campaign_id}`;
    merged.set(k, { ...p, credit: (merged.get(k)?.credit || 0) + p.credit });
  }
  return [...merged.values()];
}

export function computeAttribution() {
  const lookback = getSetting('attribution_lookback_days') * 864e5;
  const ts = now();
  return tx(() => {
    run('DELETE FROM attribution_results');
    const outcomes = q(`SELECT o.id, o.contact_id, o.type, o.occurred_at FROM outcomes o WHERE o.contact_id IS NOT NULL`);
    const byContact = new Map();
    for (const o of outcomes) {
      if (!byContact.has(o.contact_id)) byContact.set(o.contact_id, []);
      byContact.get(o.contact_id).push(o);
    }
    const ins = (oid, model, part, cohort) => run(
      'INSERT INTO attribution_results (outcome_id, model, channel_id, campaign_id, credit, cohort_month, computed_at) VALUES (?,?,?,?,?,?,?)',
      oid, model, part.channel_id, part.campaign_id, part.credit, cohort, ts,
    );
    let n = 0;
    for (const [contactId, list] of byContact) {
      const touches = q(`SELECT channel_id, campaign_id, occurred_at FROM touchpoints WHERE contact_id = ? AND type NOT IN ('open') AND channel_id IS NOT NULL ORDER BY occurred_at, id`, contactId);
      const applied = list.filter((o) => o.type === 'applied').map((o) => o.occurred_at).sort()[0];
      const leadAt = list.filter((o) => o.type === 'lead').map((o) => o.occurred_at).sort()[0];
      for (const o of list) {
        // Reference date: the application, or the lead date for a lead (or the outcome itself).
        const ref = o.type === 'lead' ? o.occurred_at : (applied || leadAt || o.occurred_at);
        const refT = new Date(ref).getTime() + 1;
        const inWindow = touches.filter((t) => { const x = new Date(t.occurred_at).getTime(); return x <= refT && x >= refT - lookback; });
        const cohort = monthOf(inWindow[0]?.occurred_at || touches[0]?.occurred_at || leadAt || o.occurred_at);
        for (const model of MODELS) for (const part of creditTouches(inWindow, model)) { ins(o.id, model, part, cohort); n++; }
      }
    }
    return n;
  });
}

// ANL-16: how often the self-reported source agrees with tracked first touch.
export function selfReportedAgreement({ from, to } = {}) {
  const rows = q(`SELECT o.self_reported_channel_id s, ar.channel_id t FROM outcomes o JOIN attribution_results ar ON ar.outcome_id = o.id AND ar.model = 'first_touch'
                  WHERE o.type = 'applied' AND o.self_reported_channel_id IS NOT NULL ${from ? 'AND o.occurred_at >= ?' : ''} ${to ? 'AND o.occurred_at <= ?' : ''}`, ...[from, to].filter(Boolean));
  if (!rows.length) return { total: 0, agree: 0, rate: null };
  const agree = rows.filter((r) => r.s === r.t).length;
  return { total: rows.length, agree, rate: agree / rows.length };
}

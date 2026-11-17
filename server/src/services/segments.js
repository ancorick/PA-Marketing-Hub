// Segment rule engine (AUD-13, AUD-14, AUD-15). Rules are JSON, compiled to SQL
// from a whitelist of fields and operators; values are always bound parameters,
// never concatenated (NFR-S7: no injection through segment rules).
import { q, one, run, now, json, parse, tx } from '../db.js';
import { bad, notFound } from '../lib/util.js';
import { audit } from '../lib/core.js';

const daysAgo = (n) => new Date(Date.now() - Number(n) * 864e5).toISOString();
const num = (v, max = 3650) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw bad(`Invalid number in rule: ${v}`);
  return n;
};
const list = (v) => {
  const a = Array.isArray(v) ? v : [v];
  if (!a.length || a.length > 50) throw bad('A list condition needs 1 to 50 values');
  return a.map(String);
};
const inList = (col, op, v) => {
  const vals = list(v);
  const ph = vals.map(() => '?').join(',');
  return { sql: `${col} ${op === 'not_in' ? 'NOT IN' : 'IN'} (${ph})`, params: vals };
};

// field -> compiler(op, value) => { sql, params }
export const FIELDS = {
  type: { label: 'Contact type', ops: ['in', 'not_in'], values: ['subscriber', 'lead', 'applicant', 'student', 'alumnus'], compile: (op, v) => inList('c.type', op, v) },
  language: { label: 'Preferred language', ops: ['in', 'not_in'], values: ['hy', 'en', 'ru'], compile: (op, v) => inList('c.language', op, v) },
  course_family: { label: 'Course family', ops: ['in', 'not_in'], compile: (op, v) => inList("COALESCE(c.course_family,'')", op, v) },
  source_channel: {
    label: 'First-touch channel', ops: ['in', 'not_in'],
    compile: (op, v) => { const vals = list(v); return { sql: `${op === 'not_in' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.source_channel_id AND ch.slug IN (${vals.map(() => '?').join(',')}))`, params: vals }; },
  },
  tag: {
    label: 'Tag', ops: ['has', 'not_has'],
    compile: (op, v) => ({ sql: `${op === 'not_has' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)`, params: [String(v)] }),
  },
  consent: {
    label: 'Consent granted for topic', ops: ['granted', 'not_granted'], values: ['newsletter', 'courses', 'events', 'alumni'],
    compile: (op, v) => ({
      sql: `${op === 'not_granted' ? 'NOT ' : ''}((SELECT state FROM consent_records cr WHERE cr.contact_id = c.id AND cr.topic = ? ORDER BY cr.id DESC LIMIT 1) = 'granted')`,
      params: [String(v)],
    }),
  },
  event_attended: {
    label: 'Attended an event', ops: ['within_days', 'never'],
    compile: (op, v) => {
      const o = typeof v === 'object' && v ? v : { days: v };
      const parts = ['r.contact_id = c.id', 'r.checked_in_at IS NOT NULL']; const params = [];
      if (o.event_type) { parts.push('e.type = ?'); params.push(String(o.event_type)); }
      if (op === 'within_days') { parts.push('r.checked_in_at >= ?'); params.push(daysAgo(num(o.days ?? 90))); }
      return { sql: `${op === 'never' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE ${parts.join(' AND ')})`, params };
    },
  },
  event_registered: {
    label: 'Registered for event', ops: ['is'],
    compile: (_op, v) => ({ sql: `EXISTS (SELECT 1 FROM event_registrations r WHERE r.contact_id = c.id AND r.event_id = ? AND r.cancelled_at IS NULL)`, params: [Number(v)] }),
  },
  opened_within_days: {
    label: 'Opened an email in the last N days (estimated)', ops: ['yes', 'no'],
    compile: (op, v) => ({ sql: `${op === 'no' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM deliveries d WHERE d.contact_id = c.id AND d.opened_at >= ?)`, params: [daysAgo(num(v))] }),
  },
  clicked_within_days: {
    label: 'Clicked an email in the last N days', ops: ['yes', 'no'],
    compile: (op, v) => ({ sql: `${op === 'no' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM deliveries d WHERE d.contact_id = c.id AND d.first_click_at >= ?)`, params: [daysAgo(num(v))] }),
  },
  no_engagement_days: {
    label: 'No open or click for N days', ops: ['gte'],
    compile: (_op, v) => ({ sql: `NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.contact_id = c.id AND (d.opened_at >= ? OR d.first_click_at >= ?))`, params: [daysAgo(num(v)), daysAgo(num(v))] }),
  },
  subscribed_days: {
    label: 'Contact for more than N days', ops: ['gte', 'lte'],
    compile: (op, v) => ({ sql: `c.created_at ${op === 'gte' ? '<=' : '>='} ?`, params: [daysAgo(num(v))] }),
  },
  first_touch_days: {
    label: 'First touch within N days', ops: ['lte', 'gte'],
    compile: (op, v) => ({ sql: `c.first_touch_at ${op === 'lte' ? '>=' : '<='} ?`, params: [daysAgo(num(v))] }),
  },
  employment_status: { label: 'Employment status (Alumni Tracker)', ops: ['in', 'not_in'], values: ['employed', 'searching'], compile: (op, v) => inList("COALESCE(c.employment_status,'')", op, v) },
  in_active_admissions: {
    label: 'In an active admissions stage', ops: ['is'],
    compile: (_op, v) => ({ sql: v === true || v === 'true' ? `c.type = 'applicant'` : `c.type != 'applicant'`, params: [] }),
  },
  referred_enrolled: {
    label: 'Referred enrolled students (at least)', ops: ['gte'],
    compile: (_op, v) => ({ sql: 'c.referred_enrolled >= ?', params: [num(v, 1000)] }),
  },
  status: { label: 'Status', ops: ['in', 'not_in'], values: ['pending', 'active', 'unsubscribed', 'bounced', 'complained'], compile: (op, v) => inList('c.status', op, v) },
};

function compileNode(node, depth = 0) {
  if (depth > 5) throw bad('Rules can be nested at most 5 levels deep');
  if (node && Array.isArray(node.conditions)) {
    const joiner = node.match === 'any' ? ' OR ' : ' AND ';
    if (!node.conditions.length) return { sql: '1=1', params: [] };
    const parts = node.conditions.map((n) => compileNode(n, depth + 1));
    return { sql: `(${parts.map((p) => p.sql).join(joiner)})`, params: parts.flatMap((p) => p.params) };
  }
  const f = FIELDS[node?.field];
  if (!f) throw bad(`Unknown segment field: ${node?.field}`);
  if (!f.ops.includes(node.op)) throw bad(`Operator "${node.op}" is not allowed for ${node.field}`);
  return f.compile(node.op, node.value);
}

export function compileRule(rule) {
  const r = typeof rule === 'string' ? parse(rule, null) : rule;
  if (!r || typeof r !== 'object') throw bad('Segment rule must be an object');
  const body = compileNode(r);
  return { where: `c.merged_into IS NULL AND c.status != 'erased' AND ${body.sql}`, params: body.params };
}

export function evaluateRule(rule, { limit } = {}) {
  const { where, params } = compileRule(rule);
  return q(`SELECT c.id FROM contacts c WHERE ${where} ORDER BY c.id ${limit ? 'LIMIT ' + Number(limit) : ''}`, ...params).map((r) => r.id);
}
export function countRule(rule) {
  const { where, params } = compileRule(rule);
  return one(`SELECT COUNT(*) n FROM contacts c WHERE ${where}`, ...params).n;
}

export function segmentContactIds(segmentId) {
  const s = getSegment(segmentId);
  if (!s) throw notFound('Segment not found');
  if (s.type === 'static') return q(`SELECT sm.contact_id id FROM segment_members sm JOIN contacts c ON c.id = sm.contact_id WHERE sm.segment_id = ? AND c.merged_into IS NULL AND c.status != 'erased'`, segmentId).map((r) => r.id);
  return evaluateRule(s.rule);
}

export function getSegment(id) {
  const s = one('SELECT * FROM segments WHERE id = ?', id);
  if (s) s.rule = parse(s.rule, { match: 'all', conditions: [] });
  return s;
}
export function listSegments() {
  return q('SELECT * FROM segments ORDER BY name').map((s) => ({ ...s, rule: parse(s.rule) }));
}
export function saveSegment(data, actor, id) {
  if (!data.name || !String(data.name).trim()) throw bad('Segment name is required');
  const type = data.type === 'static' ? 'static' : 'dynamic';
  const rule = data.rule || { match: 'all', conditions: [] };
  if (type === 'dynamic') compileRule(rule);
  return tx(() => {
    let sid = id;
    if (id) {
      if (!getSegment(id)) throw notFound('Segment not found');
      run('UPDATE segments SET name=?, description=?, rule=?, type=?, updated_at=? WHERE id=?', data.name, data.description || null, json(rule), type, now(), id);
    } else {
      sid = Number(run('INSERT INTO segments (name, description, rule, type, owner_id, updated_at) VALUES (?,?,?,?,?,?)', data.name, data.description || null, json(rule), type, actor?.id ?? null, now()).lastInsertRowid);
    }
    if (type === 'static' && Array.isArray(data.contact_ids)) {
      run('DELETE FROM segment_members WHERE segment_id = ?', sid);
      for (const cid of data.contact_ids) run('INSERT OR IGNORE INTO segment_members (segment_id, contact_id) VALUES (?,?)', sid, Number(cid));
    }
    const count = segmentContactIds(sid).length;
    run('UPDATE segments SET last_count = ? WHERE id = ?', count, sid);
    audit(actor, id ? 'segment.update' : 'segment.create', { entity: 'segment', entityId: sid, meta: { name: data.name } });
    return getSegment(sid);
  });
}
export function deleteSegment(id, actor) {
  const used = one(`SELECT COUNT(*) n FROM sends WHERE segment_id = ? AND status IN ('approved','scheduled','sending')`, id).n;
  if (used) throw bad('This segment is used by a scheduled send');
  run('DELETE FROM segments WHERE id = ?', id);
  audit(actor, 'segment.delete', { entity: 'segment', entityId: id });
}
export function fieldCatalog() {
  return Object.entries(FIELDS).map(([key, f]) => ({ key, label: f.label, ops: f.ops, values: f.values || null }));
}

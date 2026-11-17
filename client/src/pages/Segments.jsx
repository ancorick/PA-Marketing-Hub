import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, useAction, useCan, useDebounced, fmtNum, fmtDateTime } from '../lib.jsx';
import { PageHead, Card, Async, Field, Confirm, Seg } from '../ui.jsx';

export function Segments() {
  const can = useCan();
  const state = useApi('/segments');
  return (
    <>
      <PageHead title="Segments" sub="Dynamic segments are recalculated at send time, so someone who applied yesterday drops out of a recruitment email today.">
        {can('segments.edit') && <Link className="btn primary" to="/segments/new">New segment</Link>}
      </PageHead>
      <Async state={state}>{(rows) => (
        <Card>
          <table className="t"><thead><tr><th>Segment</th><th>Type</th><th className="num">Contacts (last count)</th><th>Updated</th></tr></thead>
            <tbody>{rows.map((s) => <tr key={s.id}><td><Link to={`/segments/${s.id}`}><b>{s.name}</b></Link>{s.description && <div className="faint small">{s.description}</div>}</td>
              <td><span className="badge">{s.type}</span></td><td className="num">{fmtNum(s.last_count)}</td><td className="small">{fmtDateTime(s.updated_at)}</td></tr>)}</tbody></table>
        </Card>
      )}</Async>
    </>
  );
}

const DEFAULT_VALUE = { event_attended: { event_type: 'open_day', days: 90 }, opened_within_days: 90, clicked_within_days: 90, no_engagement_days: 120, subscribed_days: 180, first_touch_days: 90, referred_enrolled: 1, in_active_admissions: false, consent: 'newsletter' };

function Condition({ c, fields, onChange, onRemove }) {
  const f = fields.find((x) => x.key === c.field) || fields[0];
  const setField = (key) => { const nf = fields.find((x) => x.key === key); onChange({ field: key, op: nf.ops[0], value: DEFAULT_VALUE[key] ?? (nf.values ? [nf.values[0]] : '') }); };
  let input;
  if (c.field === 'event_attended') {
    const v = typeof c.value === 'object' && c.value ? c.value : {};
    input = <span className="row">
      <select className="i inline" aria-label="Event type" value={v.event_type || ''} onChange={(e) => onChange({ ...c, value: { ...v, event_type: e.target.value || undefined } })}><option value="">any event</option>{['open_day', 'workshop', 'info_session', 'meetup', 'graduation'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select>
      {c.op === 'within_days' && <><span className="faint">in last</span><input className="i inline" aria-label="Days" type="number" style={{ width: 80 }} value={v.days ?? 90} onChange={(e) => onChange({ ...c, value: { ...v, days: Number(e.target.value) } })} /><span className="faint">days</span></>}
    </span>;
  } else if (c.field === 'in_active_admissions') {
    input = <select className="i inline" aria-label="Value" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value === 'true' })}><option value="true">yes</option><option value="false">no</option></select>;
  } else if (c.field === 'consent') {
    input = <select className="i inline" aria-label="Topic" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })}>{f.values.map((v) => <option key={v}>{v}</option>)}</select>;
  } else if (f.values) {
    const cur = Array.isArray(c.value) ? c.value : [c.value];
    input = <span className="row" style={{ gap: 4 }}>{f.values.map((v) => <label key={v} className="pill-x"><input type="checkbox" checked={cur.includes(v)} onChange={(e) => onChange({ ...c, value: e.target.checked ? [...cur, v] : cur.filter((x) => x !== v) })} />{v}</label>)}</span>;
  } else if (['in', 'not_in'].includes(c.op)) {
    input = <input className="i inline" aria-label="Values, comma separated" placeholder="comma separated" value={(Array.isArray(c.value) ? c.value : [c.value]).join(', ')} onChange={(e) => onChange({ ...c, value: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />;
  } else {
    input = <input className="i inline" aria-label="Value" style={{ width: 120 }} value={c.value ?? ''} onChange={(e) => onChange({ ...c, value: e.target.value })} />;
  }
  return (
    <div className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--rule)' }}>
      <select className="i inline" aria-label="Field" value={c.field} onChange={(e) => setField(e.target.value)}>{fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
      <select className="i inline" aria-label="Operator" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value })}>{f.ops.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select>
      {input}
      <button className="btn sm ghost" onClick={onRemove} aria-label="Remove condition">✕</button>
    </div>
  );
}

export function SegmentEditor() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const can = useCan();
  const fields = useApi('/segments/fields');
  const seg = useApi(isNew ? null : `/segments/${id}`, [id]);
  const [form, setForm] = useState(isNew ? { name: '', description: '', type: 'dynamic', rule: { match: 'all', conditions: [] }, emails: '' } : null);
  const [preview, setPreview] = useState(null);
  const [run, busy] = useAction();
  const [del, setDel] = useState(false);
  useEffect(() => { if (seg.data && !form) setForm({ ...seg.data, emails: '' }); }, [seg.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const ruleKey = useDebounced(JSON.stringify(form?.rule || {}), 400);
  useEffect(() => {
    const rule = JSON.parse(ruleKey);
    if (!form || form.type !== 'dynamic' || !can('segments.edit') || !Array.isArray(rule.conditions)) return;
    api('/segments/preview', { method: 'POST', body: { rule } }).then(setPreview).catch((e) => setPreview({ error: e.message }));
  }, [ruleKey, form?.type]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!form || !fields.data) return <Async state={fields.error ? fields : seg}>{() => null}</Async>;
  const setCond = (i, c) => setForm({ ...form, rule: { ...form.rule, conditions: form.rule.conditions.map((x, j) => (i === j ? c : x)) } });
  const save = async () => {
    const body = { name: form.name, description: form.description, type: form.type, rule: form.rule, ...(form.type === 'static' && form.emails.trim() ? { emails: form.emails.split(/[\s,;]+/).filter(Boolean) } : {}) };
    const r = await run(() => api(isNew ? '/segments' : `/segments/${id}`, { method: isNew ? 'POST' : 'PUT', body }), 'Segment saved');
    if (r) nav(`/segments/${r.id}`, { replace: true });
    if (r && !isNew) seg.reload();
  };
  return (
    <>
      <PageHead title={isNew ? 'New segment' : form.name} sub={<Link to="/segments">← Segments</Link>}>
        {!isNew && can('contacts.export') && <a className="btn" href={`/api/segments/${id}/export`}>Export CSV (logged)</a>}
        {!isNew && <Link className="btn" to={`/audience?segment=${id}`}>Show contacts</Link>}
        {!isNew && can('segments.edit') && <button className="btn danger" onClick={() => setDel(true)}>Delete</button>}
      </PageHead>
      <div className="grid grid-2" style={{ alignItems: 'start', gridTemplateColumns: '2fr 1fr' }}>
        <Card title="Definition">
          <Field label="Name" id="s-n"><input id="s-n" className="i" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Description" id="s-d"><input id="s-d" className="i" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="field"><label className="f">Type</label><Seg label="Type" value={form.type} onChange={(v) => setForm({ ...form, type: v })} options={[['dynamic', 'Dynamic (rules)'], ['static', 'Static list']]} /></div>
          {form.type === 'dynamic' ? (
            <>
              <div className="row" style={{ marginBottom: 6 }}><span className="small muted">Contacts matching</span>
                <Seg label="Match" value={form.rule.match} onChange={(v) => setForm({ ...form, rule: { ...form.rule, match: v } })} options={[['all', 'all'], ['any', 'any']]} /><span className="small muted">of these conditions</span></div>
              {form.rule.conditions.map((c, i) => <Condition key={i} c={c} fields={fields.data} onChange={(nc) => setCond(i, nc)} onRemove={() => setForm({ ...form, rule: { ...form.rule, conditions: form.rule.conditions.filter((_, j) => j !== i) } })} />)}
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setForm({ ...form, rule: { ...form.rule, conditions: [...form.rule.conditions, { field: 'type', op: 'in', value: ['subscriber'] }] } })}>+ Add condition</button>
            </>
          ) : (
            <Field label="Add people by email" id="s-e" hint={`Paste addresses separated by commas or new lines. ${seg.data ? `Currently ${fmtNum(seg.data.count)} members.` : ''} Saving with addresses replaces the list.`}>
              <textarea id="s-e" className="i" value={form.emails} onChange={(e) => setForm({ ...form, emails: e.target.value })} />
            </Field>
          )}
          {can('segments.edit') && <div className="row" style={{ marginTop: 16 }}><button className="btn primary" disabled={busy || !form.name.trim()} onClick={save}>Save segment</button></div>}
        </Card>
        <Card title="Live count" sub="Before send-time exclusions (suppression, consent, active applicants)">
          {form.type === 'static' ? <div className="value" style={{ fontSize: 28, fontWeight: 650 }}>{fmtNum(seg.data?.count ?? 0)}</div>
            : preview?.error ? <div className="err small">{preview.error}</div>
              : preview ? <>
                <div style={{ fontSize: 30, fontWeight: 650 }}>{fmtNum(preview.count)}</div><div className="faint small">contacts match now</div>
                <ul className="list-plain small" style={{ marginTop: 10 }}>{preview.sample.map((c) => <li key={c.id}><Link to={`/audience/contacts/${c.id}`}>{c.first_name} {c.last_name}</Link> <span className="faint">· {c.type} · {c.language}</span></li>)}</ul>
              </> : <div className="faint">Counting…</div>}
        </Card>
      </div>
      {del && <Confirm title="Delete segment?" danger confirmLabel="Delete" busy={busy} onClose={() => setDel(false)} text={`"${form.name}" will be deleted. Contacts are not affected. Segments used by a scheduled send cannot be deleted.`}
        onConfirm={async () => { if (await run(() => api(`/segments/${id}`, { method: 'DELETE' }), 'Deleted')) nav('/segments'); }} />}
    </>
  );
}

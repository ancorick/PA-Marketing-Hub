import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, useAction, useCan, useDebounced, useQueryState, fmtDate, fmtDateTime, LANG_LABEL } from '../lib.jsx';
import { PageHead, Card, Async, Status, Field, Modal, Confirm } from '../ui.jsx';

const TYPES = ['subscriber', 'lead', 'applicant', 'student', 'alumnus'];
const TOPICS = ['newsletter', 'courses', 'events', 'alumni'];

export function Contacts() {
  const can = useCan();
  const nav = useNavigate();
  const [q, setQ] = useQueryState({ search: '', type: '', status: '', language: '', segment: '', page: '1' });
  const search = useDebounced(q.search);
  const qs = new URLSearchParams({ ...q, search }).toString();
  const state = useApi(`/contacts?${qs}`, [qs]);
  return (
    <>
      <PageHead title="Contacts" sub="One record per person, from first contact to alumnus. Subscribers, leads, students and alumni share one base with consent records and one-click unsubscribe.">
        <Link className="btn" to="/audience/duplicates">Review duplicates</Link>
        {can('contacts.edit') && <Link className="btn primary" to="/audience/import">Import CSV</Link>}
      </PageHead>
      <div className="card no-print" style={{ padding: 12, marginBottom: 16 }}>
        <div className="row">
          <input className="i inline" style={{ minWidth: 240 }} placeholder="Search name, email or phone" aria-label="Search contacts" value={q.search} onChange={(e) => setQ({ search: e.target.value, page: '1' })} />
          <select className="i inline" aria-label="Type" value={q.type} onChange={(e) => setQ({ type: e.target.value, page: '1' })}><option value="">All types</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <select className="i inline" aria-label="Status" value={q.status} onChange={(e) => setQ({ status: e.target.value, page: '1' })}><option value="">Any status</option>{['active', 'pending', 'unsubscribed', 'bounced', 'complained', 'erased'].map((t) => <option key={t}>{t}</option>)}</select>
          <select className="i inline" aria-label="Language" value={q.language} onChange={(e) => setQ({ language: e.target.value, page: '1' })}><option value="">All languages</option>{Object.entries(LANG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          {q.segment && <span className="pill-x">Segment #{q.segment} <button className="btn sm ghost" aria-label="Clear segment filter" onClick={() => setQ({ segment: '', page: '1' })}>✕</button></span>}
        </div>
      </div>
      <Async state={state}>{(d) => (
        <Card title={`${d.total.toLocaleString('en-US')} contacts`}>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Language</th><th>Newsletter consent</th><th>Status</th><th>First touch</th><th>Source</th></tr></thead>
            <tbody>{d.rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => nav(`/audience/contacts/${c.id}`)}>
                <td><Link to={`/audience/contacts/${c.id}`} onClick={(e) => e.stopPropagation()}>{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</Link></td>
                <td className="small">{c.email || <span className="faint">erased</span>}</td><td><span className="badge">{c.type}</span></td><td>{c.language.toUpperCase()}</td>
                <td><Status value={c.newsletter_consent || 'unknown'} /></td><td><Status value={c.status} /></td><td className="small nowrap">{fmtDate(c.first_touch_at)}</td><td className="small">{c.source_channel || '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="row between" style={{ marginTop: 12 }}>
            <span className="small muted">Page {d.page} of {Math.max(1, Math.ceil(d.total / d.size))}</span>
            <span className="row"><button className="btn sm" disabled={d.page <= 1} onClick={() => setQ({ page: String(d.page - 1) })}>Previous</button><button className="btn sm" disabled={d.page * d.size >= d.total} onClick={() => setQ({ page: String(d.page + 1) })}>Next</button></span>
          </div>
        </Card>
      )}</Async>
    </>
  );
}

export function ContactDetail() {
  const { id } = useParams();
  const can = useCan();
  const state = useApi(`/contacts/${id}`, [id]);
  const [run, busy] = useAction();
  const [consentEdit, setConsentEdit] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [edit, setEdit] = useState(null);
  const done = (r) => { if (r) { setConfirm(null); setConsentEdit(null); setEdit(null); state.reload(); } };
  return (
    <Async state={state}>{(d) => {
      const c = d.contact;
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.status === 'erased' ? 'Erased contact' : c.email);
      return (
        <>
          <PageHead title={name} sub={<><Link to="/audience">← Contacts</Link> · #{c.id}{c.core_person_id && <> · Core Engine person <span className="mono">{c.core_person_id}</span></>}</>}>
            {c.status !== 'erased' && can('contacts.edit') && <button className="btn" onClick={() => setEdit({ first_name: c.first_name || '', last_name: c.last_name || '', phone: c.phone || '', language: c.language, tags: c.tags.join(', ') })}>Edit</button>}
            {can('contacts.export') && c.status !== 'erased' && <a className="btn" href={`/api/contacts/${c.id}/export`}>Export data (access request)</a>}
            {c.status !== 'erased' && c.status !== 'unsubscribed' && can('contacts.edit') && <button className="btn danger" onClick={() => setConfirm('unsub')}>Unsubscribe</button>}
            {c.status !== 'erased' && can('consent.manual') && <button className="btn danger" onClick={() => setConfirm('erase')}>Erase</button>}
          </PageHead>
          {d.suppressed && <div className="callout bad" style={{ marginBottom: 16 }}>On the suppression list ({d.suppression?.reason?.replace('_', ' ')} since {fmtDateTime(d.suppression?.recorded_at)}). No segment, import or staff action can send marketing email to this address.</div>}
          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <Card title="Profile">
              <dl className="kv">
                <dt>Email</dt><dd>{c.email || '—'}</dd><dt>Phone</dt><dd>{c.phone || '—'}</dd>
                <dt>Type</dt><dd><span className="badge">{c.type}</span></dd><dt>Status</dt><dd><Status value={c.status} /> {c.engagement !== 'normal' && <span className="badge warn">{c.engagement}</span>}</dd>
                <dt>Language</dt><dd>{LANG_LABEL[c.language]}</dd><dt>Course family</dt><dd>{c.course_family || '—'}</dd>
                <dt>First touch</dt><dd>{fmtDateTime(c.first_touch_at)} · {d.source || 'unknown channel'}{d.campaign && ` · ${d.campaign}`}</dd>
                <dt>Employment</dt><dd>{c.employment_status || '—'}{c.referred_enrolled ? ` · referred ${c.referred_enrolled} enrolled` : ''}</dd>
                <dt>Tags</dt><dd>{c.tags.length ? c.tags.map((t) => <span key={t} className="pill-x">{t}</span>) : '—'}</dd>
                {d.mergedFrom.length > 0 && <><dt>Merged from</dt><dd>{d.mergedFrom.map((m) => `#${m.id} ${m.email || ''}`).join(', ')}</dd></>}
              </dl>
            </Card>
            <Card title="Consent" sub="Current state per topic. The full log below is append-only.">
              <table className="t"><tbody>{TOPICS.map((t) => (
                <tr key={t}><td style={{ textTransform: 'capitalize' }}>{t}</td><td><Status value={d.consent[t]} /></td>
                  <td className="num">{can('consent.manual') && c.status !== 'erased' && <button className="btn sm ghost" onClick={() => setConsentEdit({ topic: t, state: d.consent[t] === 'granted' ? 'withdrawn' : 'granted', reason: '' })}>Change…</button>}</td></tr>
              ))}</tbody></table>
              <details style={{ marginTop: 10 }}><summary className="small">Consent log ({d.consentLog.length})</summary>
                <ul className="list-plain small">{d.consentLog.map((r) => <li key={r.id}><b>{r.topic}</b>: <Status value={r.state} /> via {r.method}{r.wording_version && ` · wording ${r.wording_version}`} · {fmtDateTime(r.recorded_at)}{r.actor && ` · by ${r.actor}`}{r.reason && <div className="faint">Reason: {r.reason}</div>}{r.source_url && <div className="faint">{r.source_url}</div>}</li>)}</ul>
              </details>
            </Card>
          </div>
          <Card title="Timeline" sub="Consent changes, emails, opens (estimated) and clicks, events and lifecycle changes">
            {d.timeline.length ? <ul className="list-plain timeline">{d.timeline.map((e, i) => <li key={i}><span className="small faint nowrap">{fmtDateTime(e.at)}</span><span><span className="badge" style={{ marginRight: 6 }}>{e.kind}</span>{e.text}</span></li>)}</ul> : <div className="empty">Nothing yet.</div>}
          </Card>
          {consentEdit && (
            <Modal title={`Change ${consentEdit.topic} consent`} onClose={() => setConsentEdit(null)} footer={<><button className="btn" onClick={() => setConsentEdit(null)}>Cancel</button>
              <button className="btn primary" disabled={busy || consentEdit.reason.trim().length < 3} onClick={async () => done(await run(() => api(`/contacts/${c.id}/consent`, { method: 'POST', body: consentEdit }), 'Consent recorded'))}>Record change</button></>}>
              <p className="muted small">Manual changes need a reason and are written to the activity log. A withdrawal can never be overridden by staff; only the person can re-subscribe.</p>
              <Field label="New state" id="cs"><select id="cs" className="i" value={consentEdit.state} onChange={(e) => setConsentEdit({ ...consentEdit, state: e.target.value })}><option value="granted">granted</option><option value="withdrawn">withdrawn</option></select></Field>
              <Field label="Reason" id="cr"><input id="cr" className="i" value={consentEdit.reason} onChange={(e) => setConsentEdit({ ...consentEdit, reason: e.target.value })} placeholder="e.g. Asked by phone on 12 Nov to stop course emails" /></Field>
            </Modal>
          )}
          {edit && (
            <Modal title="Edit contact" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={async () => done(await run(() => api(`/contacts/${c.id}`, { method: 'PATCH', body: { ...edit, tags: edit.tags.split(',').map((x) => x.trim()).filter(Boolean) } }), 'Saved'))}>Save</button></>}>
              <div className="grid grid-2" style={{ gap: 12 }}>
                <Field label="First name" id="fn"><input id="fn" className="i" value={edit.first_name} onChange={(e) => setEdit({ ...edit, first_name: e.target.value })} /></Field>
                <Field label="Last name" id="ln"><input id="ln" className="i" value={edit.last_name} onChange={(e) => setEdit({ ...edit, last_name: e.target.value })} /></Field>
              </div>
              <Field label="Phone" id="ph"><input id="ph" className="i" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
              <Field label="Language" id="lg"><select id="lg" className="i" value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value })}>{Object.entries(LANG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Tags (comma separated)" id="tg"><input id="tg" className="i" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} /></Field>
            </Modal>
          )}
          {confirm === 'unsub' && <Confirm title="Unsubscribe from all marketing?" danger confirmLabel="Unsubscribe" busy={busy} onClose={() => setConfirm(null)}
            text={`${c.email} will be withdrawn from every topic and added to the suppression list. Scheduled sends drop this person within a minute. Only the person can re-subscribe.`}
            onConfirm={async () => done(await run(() => api(`/contacts/${c.id}/unsubscribe`, { method: 'POST', body: { reason: 'Unsubscribe request received by staff' } }), 'Unsubscribed'))} />}
          {confirm === 'erase' && <Confirm title="Erase this person's data?" danger confirmLabel="Erase permanently" busy={busy} onClose={() => setConfirm(null)}
            text="Name, email, phone and tags are deleted. An anonymized row stays for aggregate analytics, and a one-way hash of the email stays on the suppression list so the address is never mailed again. This cannot be undone."
            onConfirm={async () => done(await run(() => api(`/contacts/${c.id}/erase`, { method: 'POST', body: { reason: 'Erasure request' } }), 'Erased'))} />}
        </>
      );
    }}</Async>
  );
}

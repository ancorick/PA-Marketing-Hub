import { useState } from 'react';
import { api, useApi, useAction, useCan, useQueryState, fmtNum, fmtAmd, fmtDate, fmtDateTime, isoDay, readFileText } from '../lib.jsx';
import { PageHead, Card, Async, Field, Modal, Status } from '../ui.jsx';
import { RangeFilters, rangeDefaults } from '../filters.jsx';

export default function Events() {
  const can = useCan();
  const [q, setQ] = useQueryState(rangeDefaults('12m'));
  const qs = `from=${q.from}&to=${q.to}&model=${q.model}`;
  const view = useApi(`/analytics/events?${qs}`, [qs]);
  const events = useApi('/events');
  const msgs = useApi('/events/messages');
  const [run, busy] = useAction();
  const [create, setCreate] = useState(null);
  const [att, setAtt] = useState(null);
  const [media, setMedia] = useState(null);
  const upcoming = (events.data || []).filter((e) => new Date(e.starts_at) > new Date());
  return (
    <>
      <PageHead title="Events" sub="Event Hub is the fourth module: registrations become contacts with consent, attendance is a touchpoint, event costs are channel costs, and upcoming events feed the newsletter.">
        {can('events.edit') && <button className="btn" onClick={() => setCreate({ title: '', type: 'open_day', starts_at: isoDay(Date.now() + 14 * 864e5), public: true, registration_url: '', cost_amount: '', cost_currency: 'AMD' })}>Add event manually</button>}
      </PageHead>
      <RangeFilters q={q} setQ={setQ} />
      <Card title="Upcoming events" sub="Public events with open registration appear in the newsletter's Upcoming events block">
        {upcoming.length ? <table className="t"><thead><tr><th>Event</th><th>Date</th><th>Public</th><th className="num">Registered</th><th>Source</th></tr></thead>
          <tbody>{upcoming.map((e) => <tr key={e.id}><td><b>{e.title}</b><div className="faint small">{e.type.replace('_', ' ')}</div></td><td className="small">{fmtDateTime(e.starts_at)}</td><td>{e.is_public ? <span className="badge good">public</span> : <span className="badge">private</span>}</td><td className="num">{e.registrations}</td><td><span className="badge">{e.source}</span></td></tr>)}</tbody></table>
          : <div className="empty">No upcoming events.</div>}
      </Card>
      <Async state={view}>{(rows) => (
        <Card title="Events as a channel" sub="Cost, registrations, attendance and credited outcomes per event (selected attribution model)">
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Event</th><th>Date</th><th className="num">Cost</th><th className="num">Registered</th><th className="num">Attended</th><th className="num">Leads</th><th className="num">Enrolled</th><th className="num">Hired</th><th className="num">Cost per enrolled</th><th /></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}><td><b>{e.title}</b><div className="faint small">{e.type.replace('_', ' ')} · {e.source}</div></td><td className="small nowrap">{fmtDate(e.starts_at)}</td><td className="num">{fmtAmd(e.cost)}</td>
                <td className="num">{fmtNum(e.registrations)}</td><td className="num">{fmtNum(e.attendees)}</td><td className="num">{fmtNum(e.leads)}</td><td className="num">{fmtNum(e.enrolled)}</td><td className="num">{fmtNum(e.hired)}</td><td className="num">{fmtAmd(e.cost_per_enrolled)}</td>
                <td className="nowrap">{can('events.edit') && <><button className="btn sm ghost" onClick={() => setAtt({ id: e.id, title: e.title, csv: '' })}>Attendees CSV</button><button className="btn sm ghost" onClick={() => setMedia({ id: e.id, title: e.title, recording_url: '', photos_url: '', media_public: true })}>Media</button></>}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}</Async>
      <Card title="Event Hub integration log" sub="Signed, idempotent webhook messages (contract v1.0). Duplicates are ignored by message id.">
        <Async state={msgs}>{(rows) => rows.length ? <table className="t"><thead><tr><th>Message</th><th>Type</th><th>Received</th><th>Result</th></tr></thead>
          <tbody>{rows.map((m) => <tr key={m.idempotency_key}><td className="mono small">{m.idempotency_key}</td><td>{m.type}</td><td className="small">{fmtDateTime(m.received_at)}</td><td>{m.error ? <span className="err small">{m.error}</span> : <Status value={m.processed_at ? 'success' : 'running'}>{m.processed_at ? 'processed' : 'pending'}</Status>}</td></tr>)}</tbody></table>
          : <div className="empty">No messages yet.</div>}</Async>
      </Card>
      {create && (
        <Modal title="Add event manually" onClose={() => setCreate(null)} footer={<><button className="btn" onClick={() => setCreate(null)}>Cancel</button>
          <button className="btn primary" disabled={busy || !create.title} onClick={async () => { if (await run(() => api('/events', { method: 'POST', body: { ...create, starts_at: new Date(create.starts_at).toISOString() } }), 'Event added')) { setCreate(null); events.reload(); view.reload(); } }}>Add event</button></>}>
          <p className="small muted">Fallback while Event Hub is not connected (PRD 10.5). The same contract processes it, so nothing changes when Event Hub goes live.</p>
          <Field label="Title" id="ev-t"><input id="ev-t" className="i" value={create.title} onChange={(e) => setCreate({ ...create, title: e.target.value })} /></Field>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Type" id="ev-ty"><select id="ev-ty" className="i" value={create.type} onChange={(e) => setCreate({ ...create, type: e.target.value })}>{['open_day', 'workshop', 'info_session', 'meetup', 'graduation', 'guest_visit'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></Field>
            <Field label="Date" id="ev-d"><input id="ev-d" className="i" type="date" value={create.starts_at} onChange={(e) => setCreate({ ...create, starts_at: e.target.value })} /></Field>
          </div>
          <Field label="Registration URL" id="ev-u"><input id="ev-u" className="i" value={create.registration_url} onChange={(e) => setCreate({ ...create, registration_url: e.target.value })} placeholder="https://" /></Field>
          <label className="check"><input type="checkbox" checked={create.public} onChange={(e) => setCreate({ ...create, public: e.target.checked })} /> Public event</label>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Cost" id="ev-c"><input id="ev-c" className="i" type="number" value={create.cost_amount} onChange={(e) => setCreate({ ...create, cost_amount: e.target.value })} /></Field>
            <Field label="Currency" id="ev-cu"><select id="ev-cu" className="i" value={create.cost_currency} onChange={(e) => setCreate({ ...create, cost_currency: e.target.value })}>{['AMD', 'USD', 'EUR'].map((c) => <option key={c}>{c}</option>)}</select></Field>
          </div>
        </Modal>
      )}
      {att && (
        <Modal title={`Import attendees · ${att.title}`} onClose={() => setAtt(null)} footer={<><button className="btn" onClick={() => setAtt(null)}>Cancel</button>
          <button className="btn primary" disabled={!att.csv || busy} onClick={async () => { const r = await run(() => api(`/events/${att.id}/attendees`, { method: 'POST', body: { csv: att.csv } })); if (r) { setAtt(null); view.reload(); } }}>Import</button></>}>
          <p className="small muted">CSV with columns email, first_name, last_name, consent (yes/no) and optionally attended (yes/no). A consent column is required.</p>
          <input type="file" accept=".csv" aria-label="Attendee CSV" onChange={async (e) => { const f = e.target.files[0]; if (f) setAtt({ ...att, csv: await readFileText(f) }); }} />
        </Modal>
      )}
      {media && (
        <Modal title={`Recording and photos · ${media.title}`} onClose={() => setMedia(null)} footer={<><button className="btn" onClick={() => setMedia(null)}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => api(`/events/${media.id}/media`, { method: 'PATCH', body: media }), 'Saved')) setMedia(null); }}>Save</button></>}>
          <Field label="Recording URL" id="m-r"><input id="m-r" className="i" value={media.recording_url} onChange={(e) => setMedia({ ...media, recording_url: e.target.value })} /></Field>
          <Field label="Photos URL" id="m-p"><input id="m-p" className="i" value={media.photos_url} onChange={(e) => setMedia({ ...media, photos_url: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={media.media_public} onChange={(e) => setMedia({ ...media, media_public: e.target.checked })} /> Marked public (may appear in the newsletter)</label>
        </Modal>
      )}
    </>
  );
}

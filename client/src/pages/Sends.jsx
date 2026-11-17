import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, useAction, useCan, fmtNum, fmtPct, fmtDateTime, readFileDataUrl, LANG_LABEL } from '../lib.jsx';
import { PageHead, Card, Async, Status, Field, Checks, EmailPreview, Seg, Tabs, Confirm, Tile } from '../ui.jsx';
import { HBars } from '../charts.jsx';

export function Sends() {
  const can = useCan();
  const nav = useNavigate();
  const [kind, setKind] = useState('campaign');
  const state = useApi(`/sends?kind=${kind}`, [kind]);
  const [run, busy] = useAction();
  const create = async () => {
    const s = await run(() => api('/sends', { method: 'POST', body: { name: 'New campaign email', topic: 'courses', body: [{ id: 'h1', type: 'heading', text: 'Headline' }, { id: 't1', type: 'text', text: 'Write the message here.' }] } }));
    if (s) nav(`/campaigns/${s.id}`);
  };
  return (
    <>
      <PageHead title="Campaign emails" sub="Emails to a segment. Every send is checked, approved by a manager, sent from the authenticated domain in batches, and stops by itself if bounces or complaints spike.">
        {can('campaigns.edit') && <button className="btn primary" disabled={busy} onClick={create}>New campaign email</button>}
      </PageHead>
      <Tabs value={kind} onChange={setKind} options={[['campaign', 'Campaigns'], ['newsletter', 'Newsletter sends'], ['reengagement', 'Re-engagement']]} />
      <Async state={state}>{(rows) => (
        <Card>
          {rows.length ? <div className="table-wrap"><table className="t">
            <thead><tr><th>Name</th><th>Status</th><th>Segment</th><th>When</th><th className="num">Sent</th><th className="num">Click rate</th><th className="num">Unsubscribed</th><th className="num">Hard bounces</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}><td><Link to={`/campaigns/${s.id}`}><b>{s.name}</b></Link><div className="faint small">{s.subject}</div></td><td><Status value={s.status} />{s.pause_reason && <div className="err small">{s.pause_reason}</div>}</td>
                <td className="small">{s.segment?.name || '—'}</td><td className="small nowrap">{fmtDateTime(s.started_at || s.scheduled_at || s.created_at)}</td>
                <td className="num">{fmtNum(s.stats.sent)}</td><td className="num">{fmtPct(s.stats.click_rate)}</td><td className="num">{fmtNum(s.stats.unsubscribed)}</td><td className="num">{fmtPct(s.stats.hard_bounce_rate, 2)}</td></tr>
            ))}</tbody>
          </table></div> : <div className="empty">Nothing here yet.</div>}
        </Card>
      )}</Async>
    </>
  );
}

const NEW_BLOCK = { heading: { text: 'Heading' }, text: { text: 'Text with **bold** and [links](https://example.com).' }, button: { label: 'Learn more', url: 'https://' }, image: { src: '', alt: '' }, divider: {} };

export function BlocksEditor({ blocks, onChange, disabled }) {
  const [run] = useAction();
  const upd = (i, patch) => onChange(blocks.map((b, j) => (i === j ? { ...b, ...patch } : b)));
  const move = (i, d) => { const n = [...blocks]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n); };
  return (
    <div>
      {blocks.map((b, i) => (
        <div key={b.id} className="block-card">
          <div className="row between" style={{ marginBottom: 8 }}>
            <span className="badge">{b.type}</span>
            {!disabled && <span className="row" style={{ gap: 4 }}>
              <button className="btn sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
              <button className="btn sm ghost" disabled={i === blocks.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
              <button className="btn sm ghost danger" onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label="Remove block">✕</button>
            </span>}
          </div>
          {b.type === 'heading' && <input className="i" aria-label="Heading" disabled={disabled} value={b.text} onChange={(e) => upd(i, { text: e.target.value })} />}
          {b.type === 'text' && <textarea className="i" aria-label="Text" disabled={disabled} value={b.text} onChange={(e) => upd(i, { text: e.target.value })} />}
          {b.type === 'button' && <div className="grid grid-2" style={{ gap: 8 }}><input className="i" aria-label="Button label" disabled={disabled} value={b.label} onChange={(e) => upd(i, { label: e.target.value })} /><input className="i" aria-label="Button URL" disabled={disabled} value={b.url} onChange={(e) => upd(i, { url: e.target.value })} /></div>}
          {b.type === 'image' && <div className="stack">
            {b.src && <img src={b.src} alt={b.alt || ''} style={{ maxWidth: 240, borderRadius: 6 }} />}
            {!disabled && <input type="file" accept="image/*" aria-label="Upload image" onChange={async (e) => { const f = e.target.files[0]; if (!f) return; const r = await run(async () => api('/uploads', { method: 'POST', body: { data: await readFileDataUrl(f) } })); if (r) upd(i, { src: r.url }); }} />}
            <input className="i" aria-label="Alt text" placeholder="Alt text (required)" disabled={disabled} value={b.alt} onChange={(e) => upd(i, { alt: e.target.value })} />
          </div>}
        </div>
      ))}
      {!disabled && <div className="row" style={{ marginTop: 10 }}>{Object.keys(NEW_BLOCK).map((t) => <button key={t} className="btn sm" onClick={() => onChange([...blocks, { id: `${t}${Date.now().toString(36)}`, type: t, ...NEW_BLOCK[t] }])}>+ {t}</button>)}</div>}
    </div>
  );
}

export function SendEditor() {
  const { id } = useParams();
  const can = useCan();
  const state = useApi(`/sends/${id}`, [id]);
  const segments = useApi('/segments');
  const campaigns = useApi('/campaigns');
  const [form, setForm] = useState(null);
  const [tab, setTab] = useState('content');
  const [checks, setChecks] = useState(null);
  const [recips, setRecips] = useState(null);
  const [html, setHtml] = useState('');
  const [mobile, setMobile] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [when, setWhen] = useState('');
  const [comment, setComment] = useState('');
  const [run, busy] = useAction();
  const report = useApi(state.data && ['sending', 'sent', 'paused'].includes(state.data.status) ? `/sends/${id}/report` : null, [state.data?.status, id]);
  useEffect(() => { if (state.data) setForm({ ...state.data }); }, [state.data]);
  useEffect(() => { if (tab === 'preview') api(`/sends/${id}/preview`, { raw: true }).then(setHtml).catch(() => setHtml('')); }, [tab, id, state.data?.updated_at]);
  const editable = form && ['draft', 'approved', 'scheduled', 'paused'].includes(form.status) && can('campaigns.edit');
  const dirty = form && state.data && JSON.stringify(['name', 'subject', 'preheader', 'body', 'segment_id', 'campaign_id', 'topic', 'language', 'exclude_active_applicants'].map((k) => form[k])) !== JSON.stringify(['name', 'subject', 'preheader', 'body', 'segment_id', 'campaign_id', 'topic', 'language', 'exclude_active_applicants'].map((k) => state.data[k]));
  const save = async () => {
    const body = { name: form.name, subject: form.subject, preheader: form.preheader, body: form.body, segment_id: form.segment_id ? Number(form.segment_id) : null, campaign_id: form.campaign_id ? Number(form.campaign_id) : null, topic: form.topic, language: form.language || null, exclude_active_applicants: !!form.exclude_active_applicants };
    if (await run(() => api(`/sends/${id}`, { method: 'PATCH', body }), state.data.status !== 'draft' ? 'Saved; the email needs approval again' : 'Saved')) { state.reload(); setChecks(null); }
  };
  const act = async (path, body, ok) => { if (await run(() => api(`/sends/${id}/${path}`, { method: 'POST', body }), ok)) { setConfirm(null); state.reload(); } };
  return (
    <Async state={state}>{() => !form ? null : (
      <>
        <PageHead title={form.name} sub={<><Link to="/campaigns">← Campaign emails</Link> · <Status value={form.status} />{form.approved_at && <span className="faint"> · approved {fmtDateTime(form.approved_at)}</span>}{form.scheduled_at && form.status === 'scheduled' && <span className="faint"> · sends {fmtDateTime(form.scheduled_at)}</span>}</>}>
          {editable && <button className="btn primary" disabled={!dirty || busy} onClick={save}>Save changes</button>}
          {form.status === 'draft' && can('send.approve') && <button className="btn" disabled={dirty || busy} onClick={() => setConfirm('approve')}>Approve…</button>}
          {form.status === 'approved' && can('send.approve') && <button className="btn primary" disabled={busy} onClick={() => setConfirm('schedule')}>Schedule…</button>}
          {['sending', 'scheduled'].includes(form.status) && can('send.approve') && <button className="btn danger" onClick={() => act('pause', { reason: 'Paused by staff' }, 'Paused')}>Pause</button>}
          {form.status === 'paused' && can('send.approve') && <button className="btn" onClick={() => act('resume', {}, 'Resumed')}>Resume</button>}
          {!['sent', 'cancelled'].includes(form.status) && can('send.approve') && <button className="btn ghost danger" onClick={() => setConfirm('cancel')}>Cancel send</button>}
        </PageHead>
        {form.status === 'paused' && form.pause_reason && <div className="callout bad" style={{ marginBottom: 16 }}>Paused: {form.pause_reason}</div>}
        {dirty && form.status !== 'draft' && <div className="callout warn" style={{ marginBottom: 16 }}>Saving these edits returns the email to draft; a manager has to approve it again.</div>}
        <Tabs value={tab} onChange={setTab} options={[['content', 'Content'], ['audience', 'Audience'], ['preview', 'Preview & test'], ['checks', 'Checks'], ...(report.data ? [['report', 'Report']] : [])]} />
        {tab === 'content' && (
          <div className="grid grid-2" style={{ gridTemplateColumns: '1fr 1.3fr', alignItems: 'start' }}>
            <Card title="Settings">
              <Field label="Internal name" id="n"><input id="n" className="i" disabled={!editable} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label={`Subject (${form.subject.length}/70)`} id="s"><input id="s" className="i" disabled={!editable} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
              <Field label="Preheader" id="p" hint="The grey preview line after the subject in most inboxes"><input id="p" className="i" disabled={!editable} value={form.preheader || ''} onChange={(e) => setForm({ ...form, preheader: e.target.value })} /></Field>
              <Field label="Campaign (for attribution)" id="c"><select id="c" className="i" disabled={!editable} value={form.campaign_id || ''} onChange={(e) => setForm({ ...form, campaign_id: e.target.value })}><option value="">None</option>{(campaigns.data || []).filter((c) => c.channel_slug === 'email').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Consent topic" id="t" hint="Only contacts who granted this topic receive the email"><select id="t" className="i" disabled={!editable} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })}>{['courses', 'events', 'newsletter', 'alumni'].map((t) => <option key={t}>{t}</option>)}</select></Field>
            </Card>
            <Card title="Content blocks" sub="Footer with address, reason, preferences and one-click unsubscribe is added automatically"><BlocksEditor blocks={form.body} disabled={!editable} onChange={(b) => setForm({ ...form, body: b })} /></Card>
          </div>
        )}
        {tab === 'audience' && (
          <Card title="Who receives it">
            <Field label="Segment" id="seg"><select id="seg" className="i" disabled={!editable} value={form.segment_id || ''} onChange={(e) => setForm({ ...form, segment_id: e.target.value })}><option value="">Choose…</option>{(segments.data || []).map((s) => <option key={s.id} value={s.id}>{s.name} ({fmtNum(s.last_count)})</option>)}</select></Field>
            <Field label="Language" id="lang"><select id="lang" className="i" disabled={!editable} value={form.language || ''} onChange={(e) => setForm({ ...form, language: e.target.value })}><option value="">All languages</option>{Object.entries(LANG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <label className="check"><input type="checkbox" disabled={!editable} checked={!!form.exclude_active_applicants} onChange={(e) => setForm({ ...form, exclude_active_applicants: e.target.checked })} /> Exclude people in an active admissions stage (recommended for recruitment emails)</label>
            <div className="row" style={{ marginTop: 12 }}><button className="btn" disabled={dirty || !form.segment_id || busy} onClick={async () => setRecips(await run(() => api(`/sends/${id}/recipients`)))}>Count recipients now</button>{dirty && <span className="faint small">Save first</span>}</div>
            {recips && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 26, fontWeight: 650 }}>{fmtNum(recips.count)} recipients</div>
                <p className="small muted">Recalculated again at send time. Excluded now:</p>
                <table className="t" style={{ maxWidth: 420 }}><tbody>{Object.entries(recips.excluded).filter(([, n]) => n).map(([k, n]) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td className="num">{fmtNum(n)}</td></tr>)}</tbody></table>
              </div>
            )}
          </Card>
        )}
        {tab === 'preview' && (
          <Card title="Preview" actions={<>
            <Seg label="Width" value={mobile ? 'm' : 'd'} onChange={(v) => setMobile(v === 'm')} options={[['d', 'Desktop'], ['m', 'Mobile']]} />
            <a className="btn sm" href={`/api/sends/${id}/preview?format=text`} target="_blank" rel="noreferrer">Plain text</a>
            {can('campaigns.edit') && <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/sends/${id}/test`, { method: 'POST', body: {} }), 'Test sent to the seed list (see Dev inbox)')}>Send test to seed list</button>}
          </>}>
            {dirty && <p className="callout warn small">Showing the saved version.</p>}
            <EmailPreview html={html} mobile={mobile} />
            <p className="hint">Dark-mode clients use the email's built-in dark styles; check the seed list on a phone in dark mode before approval.</p>
          </Card>
        )}
        {tab === 'checks' && (
          <Card title="Pre-send checks" actions={<><button className="btn sm" disabled={busy} onClick={async () => setChecks(await run(() => api(`/sends/${id}/checks`, { method: 'POST', body: {} })))}>Run checks</button><button className="btn sm" disabled={busy} onClick={async () => setChecks(await run(() => api(`/sends/${id}/checks`, { method: 'POST', body: { live: true } })))}>Run with live link check</button></>}>
            {checks ? <Checks result={checks} /> : <div className="empty">Run the checks before asking for approval.</div>}
          </Card>
        )}
        {tab === 'report' && report.data && <SendReport r={report.data} />}
        {confirm === 'approve' && <Confirm title="Approve this email?" confirmLabel="Approve" busy={busy} onClose={() => setConfirm(null)} onConfirm={() => act('approve', { comment }, 'Approved')}
          text="Approval runs the pre-send checks and confirms the sending domain passes SPF, DKIM and DMARC. Any later edit returns the email to draft.">
          <Field label="Comment (optional)" id="ac"><input id="ac" className="i" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        </Confirm>}
        {confirm === 'schedule' && <Confirm title="Schedule the send" confirmLabel={when ? 'Schedule' : 'Send now'} busy={busy} onClose={() => setConfirm(null)} onConfirm={() => act('schedule', { at: when ? new Date(when).toISOString() : undefined }, 'Scheduled')}
          text="Recipients are recalculated at send time: unsubscribes, suppressions and new applicants are removed automatically. Sending respects the domain's warm-up cap and pauses on bounce or complaint spikes.">
          <Field label="Send at (leave empty to send now)" id="w"><input id="w" className="i" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        </Confirm>}
        {confirm === 'cancel' && <Confirm title="Cancel this send?" danger confirmLabel="Cancel send" busy={busy} onClose={() => setConfirm(null)} onConfirm={() => act('cancel', {}, 'Cancelled')}
          text={`No further messages will go out${form.stats.sent ? `; ${fmtNum(form.stats.sent)} already sent stay sent` : ''}. This cannot be resumed.`} />}
      </>
    )}</Async>
  );
}

export function SendReport({ r }) {
  return (
    <div className="stack">
      {!r.final && <div className="callout info">The report becomes final 7 days after sending; numbers will still grow.</div>}
      <div className="grid grid-4">
        <Tile label="Delivered" value={fmtNum(r.stats.delivered)} sub={`of ${fmtNum(r.stats.sent)} sent`} />
        <Tile label="Click rate" value={fmtPct(r.stats.click_rate)} sub={`${fmtNum(r.stats.clicked)} people clicked`} />
        <Tile label="Unsubscribed" value={fmtNum(r.stats.unsubscribed)} sub={`${fmtNum(r.stats.complained)} complaints`} />
        <Tile label="Hard bounce rate" value={fmtPct(r.stats.hard_bounce_rate, 2)} sub={`Opens ${fmtPct(r.stats.open_rate_estimated, 0)} (estimated)`} />
      </div>
      <div className="grid grid-2">
        <Card title="Clicks per block"><HBars rows={r.blocks.map((b) => ({ ...b, label: b.name || b.block_id || 'other' }))} labelKey="label" valueKey="unique_clicks" title="Unique clicks per block" /></Card>
        <Card title="What happened next" sub="Within 30 days, among people who clicked this email">
          <dl className="kv"><dt>Applications</dt><dd><b>{fmtNum(r.applications)}</b></dd><dt>Event registrations</dt><dd><b>{fmtNum(r.registrations)}</b></dd></dl>
        </Card>
      </div>
    </div>
  );
}

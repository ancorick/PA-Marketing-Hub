import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useApi, useAction, useCan, fmtDate, fmtDateTime, readFileDataUrl, LANG_LABEL } from '../lib.jsx';
import { PageHead, Card, Async, Status, Field, Checks, EmailPreview, Tabs, Confirm, Seg } from '../ui.jsx';
import { SendReport } from './Sends.jsx';

const TYPE_LABEL = { lead: 'Lead story', upcoming_events: 'Upcoming events', recent_events: 'Recent events', library: 'New in the Library', graduations: 'Graduations', hires: 'Alumni hires', new_groups: 'New groups starting', custom: 'Custom block' };

export function Issues() {
  const can = useCan();
  const issues = useApi('/newsletter/issues');
  const settings = useApi('/newsletter/settings');
  const [run, busy] = useAction();
  const [plan, setPlan] = useState('');
  const [w, setW] = useState(null);
  useEffect(() => { if (settings.data && !w) setW(settings.data); }, [settings.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHead title="Newsletter" sub="Each issue drafts itself from what happened since the last one: events, new Library items, graduations, alumni hires and new groups. A person edits, a manager approves, and the system sends and reports.">
        {can('newsletter.edit') && <span className="row">
          <input className="i inline" type="date" aria-label="Planned send date" value={plan} onChange={(e) => setPlan(e.target.value)} title="Planned send date (default: next cadence date)" />
          <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => api('/newsletter/issues', { method: 'POST', body: plan ? { planned_send_at: `${plan}T09:00:00.000Z` } : {} }), 'Drafts created in every language')) issues.reload(); }}>Draft new issue now</button>
        </span>}
      </PageHead>
      <Async state={issues}>{(rows) => (
        <Card title="Issues">
          {rows.length ? <div className="table-wrap"><table className="t">
            <thead><tr><th>Issue</th><th>Language</th><th>Status</th><th>Covers since</th><th>Planned send</th><th className="num">Blocks</th><th className="num">AI text to review</th><th className="num">Skipped items</th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id}><td><Link to={`/newsletter/${i.id}`}><b>{i.title}</b></Link><div className="faint small">{i.subject}</div></td><td>{LANG_LABEL[i.language]}</td><td><Status value={i.status} /></td>
                <td className="small">{fmtDate(i.cut_off_at)}</td><td className="small">{fmtDateTime(i.planned_send_at)}</td><td className="num">{i.blocks}</td>
                <td className="num">{i.ai_drafted ? <span className="badge warn">{i.ai_drafted}</span> : '0'}</td><td className="num">{i.skipped}</td></tr>
            ))}</tbody>
          </table></div> : <div className="empty">No issues yet.</div>}
        </Card>
      )}</Async>
      {w && (
        <Card title="Cadence and ranking" sub={`Next planned issue: ${fmtDateTime(w.next_planned)}. Collection starts ${w.cadence.collect_days_before} days earlier and the editors get a Slack and email notice.`}>
          <div className="grid grid-3" style={{ gap: 12 }}>
            <Field label="Send on day of month" id="dom"><input id="dom" className="i" type="number" min="1" max="28" value={w.cadence.day_of_month} onChange={(e) => setW({ ...w, cadence: { ...w.cadence, day_of_month: Number(e.target.value) } })} /></Field>
            <Field label="Start collecting (days before)" id="cdb"><input id="cdb" className="i" type="number" min="1" max="14" value={w.cadence.collect_days_before} onChange={(e) => setW({ ...w, cadence: { ...w.cadence, collect_days_before: Number(e.target.value) } })} /></Field>
            <div className="field"><label className="f">Languages</label><div className="row">{['hy', 'en', 'ru'].map((l) => <label key={l} className="pill-x"><input type="checkbox" checked={w.cadence.languages.includes(l)} onChange={(e) => setW({ ...w, cadence: { ...w.cadence, languages: e.target.checked ? [...w.cadence.languages, l] : w.cadence.languages.filter((x) => x !== l) } })} />{LANG_LABEL[l]}</label>)}</div></div>
          </div>
          <h3>Type weights</h3>
          <div className="grid grid-3" style={{ gap: 12 }}>{Object.entries(w.weights).map(([k, v]) => (
            <Field key={k} label={TYPE_LABEL[k]} id={`w-${k}`}><input id={`w-${k}`} className="i" type="number" step="0.1" min="0" max="2" value={v} onChange={(e) => setW({ ...w, weights: { ...w.weights, [k]: Number(e.target.value) } })} /></Field>
          ))}</div>
          {can('send.approve') && <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api('/newsletter/settings', { method: 'PUT', body: { cadence: w.cadence, weights: w.weights } }), 'Saved')) settings.reload(); }}>Save settings</button>}
        </Card>
      )}
    </>
  );
}

function BlockCard({ b, issue, editable, onSaved }) {
  const [v, setV] = useState(b);
  const [run, busy] = useAction();
  useEffect(() => setV(b), [b]);
  const changed = ['title', 'body', 'button_label', 'button_url', 'image_url', 'image_alt'].some((k) => (v[k] || '') !== (b[k] || '')) || JSON.stringify(v.source_items) !== JSON.stringify(b.source_items);
  const pool = issue.items.filter((x) => x.type === b.type);
  const patch = (body, ok) => run(() => api(`/newsletter/issues/${issue.id}/blocks/${b.id}`, { method: 'PATCH', body }), ok).then((r) => r && onSaved(r));
  return (
    <div className={`block-card ${b.ai_drafted ? 'ai' : ''}`}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <span className="row"><span className="badge">{TYPE_LABEL[b.type]}</span>{b.ai_drafted ? <span className="badge warn" title="Machine-drafted text that nobody has edited or accepted yet">AI-drafted</span> : null}</span>
        {editable && <span className="row" style={{ gap: 4 }}>
          {b.ai_drafted ? <button className="btn sm" disabled={busy} onClick={() => patch({ accept_ai: true }, 'AI text accepted')}>Accept AI text</button> : null}
          <button className="btn sm ghost" disabled={busy} aria-label="Move up" onClick={() => onSaved(null, 'up')}>↑</button>
          <button className="btn sm ghost" disabled={busy} aria-label="Move down" onClick={() => onSaved(null, 'down')}>↓</button>
          <button className="btn sm ghost danger" disabled={busy} aria-label="Remove block" onClick={() => run(() => api(`/newsletter/issues/${issue.id}/blocks/${b.id}`, { method: 'DELETE' }), 'Block removed').then((r) => r && onSaved(r))}>✕</button>
        </span>}
      </div>
      <input className="i" aria-label="Block title" disabled={!editable} value={v.title || ''} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="Title" style={{ fontWeight: 600, marginBottom: 6 }} />
      <textarea className="i" aria-label="Block text" disabled={!editable} value={v.body || ''} onChange={(e) => setV({ ...v, body: e.target.value })} placeholder="Introduction (optional)" />
      {pool.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>Items (tick to include; skipped items cannot be included)</div>
          {pool.map((it) => (
            <label key={it.id} className="check small" style={{ opacity: it.publishable ? 1 : 0.6 }}>
              <input type="checkbox" disabled={!editable || !it.publishable} checked={v.source_items.includes(it.id)} onChange={(e) => setV({ ...v, source_items: e.target.checked ? [...v.source_items, it.id] : v.source_items.filter((x) => x !== it.id) })} />
              <span><b>{it.title}</b> <span className="faint">· {it.summary} · {fmtDate(it.occurred_at)} · score {it.score}</span>{!it.publishable && <span className="badge bad" style={{ marginLeft: 6 }}>{it.skip_reason}</span>}</span>
            </label>
          ))}
        </div>
      )}
      {(b.type === 'custom' || b.type === 'lead') && (
        <div className="grid grid-2" style={{ gap: 8, marginTop: 8 }}>
          <input className="i" aria-label="Button label" disabled={!editable} placeholder="Button label" value={v.button_label || ''} onChange={(e) => setV({ ...v, button_label: e.target.value })} />
          <input className="i" aria-label="Button URL" disabled={!editable} placeholder="https://" value={v.button_url || ''} onChange={(e) => setV({ ...v, button_url: e.target.value })} />
          <span className="row">{v.image_url && <img src={v.image_url} alt={v.image_alt || ''} style={{ height: 40, borderRadius: 4 }} />}
            {editable && <input type="file" accept="image/*" aria-label="Image" onChange={async (e) => { const f = e.target.files[0]; if (!f) return; const r = await run(async () => api('/uploads', { method: 'POST', body: { data: await readFileDataUrl(f) } })); if (r) setV({ ...v, image_url: r.url }); }} />}</span>
          <input className="i" aria-label="Image alt text" disabled={!editable} placeholder="Image alt text" value={v.image_alt || ''} onChange={(e) => setV({ ...v, image_alt: e.target.value })} />
        </div>
      )}
      {editable && changed && <div className="row" style={{ marginTop: 8 }}><button className="btn sm primary" disabled={busy} onClick={() => patch({ title: v.title, body: v.body, button_label: v.button_label, button_url: v.button_url, image_url: v.image_url, image_alt: v.image_alt, source_items: v.source_items }, 'Block saved')}>Save block</button><button className="btn sm ghost" onClick={() => setV(b)}>Discard</button></div>}
    </div>
  );
}

export function IssueEditor() {
  const { id } = useParams();
  const can = useCan();
  const state = useApi(`/newsletter/issues/${id}`, [id]);
  const [tab, setTab] = useState('blocks');
  const [html, setHtml] = useState('');
  const [mobile, setMobile] = useState(false);
  const [checks, setChecks] = useState(null);
  const [head, setHead] = useState(null);
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [run, busy] = useAction();
  const issue = state.data;
  const report = useApi(issue?.send && ['sending', 'sent'].includes(issue.send.status) ? `/newsletter/issues/${id}/report` : null, [issue?.send?.status, id]);
  useEffect(() => { if (issue) setHead({ subject: issue.subject || '', preheader: issue.preheader || '' }); }, [issue?.subject, issue?.preheader]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'preview') api(`/newsletter/issues/${id}/preview`, { raw: true }).then(setHtml).catch(() => setHtml('')); }, [tab, id, issue?.updated_at]);
  const editable = issue && ['collecting', 'draft', 'in_review', 'approved'].includes(issue.status) && can('newsletter.edit');
  const setIssue = (r) => { if (r) state.setData(r); };
  const onBlock = async (r, dir, b) => {
    if (r) return setIssue(r);
    const order = issue.blocks.map((x) => x.id); const i = order.indexOf(b.id); const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return undefined;
    [order[i], order[j]] = [order[j], order[i]];
    return setIssue(await run(() => api(`/newsletter/issues/${id}/order`, { method: 'POST', body: { order } })));
  };
  const act = async (path, body, ok) => { const r = await run(() => api(`/newsletter/issues/${id}/${path}`, { method: 'POST', body }), ok); if (r) { setConfirm(null); setIssue(r.id ? r : null); state.reload(); } };
  return (
    <Async state={state}>{() => !issue || !head ? null : (
      <>
        <PageHead title={issue.title} sub={<><Link to="/newsletter">← Newsletter</Link> · {LANG_LABEL[issue.language]} · <Status value={issue.status} /> · covers {fmtDate(issue.cut_off_at)} – {fmtDate(issue.planned_send_at)} · planned {fmtDateTime(issue.planned_send_at)}</>}>
          {editable && <button className="btn" disabled={busy} onClick={() => setConfirm('regen')}>Regenerate draft</button>}
          {issue.status === 'draft' && can('newsletter.edit') && <button className="btn" disabled={busy} onClick={() => act('submit', {}, 'Sent for review')}>Submit for review</button>}
          {['draft', 'in_review'].includes(issue.status) && can('send.approve') && <button className="btn primary" disabled={busy} onClick={() => setConfirm('approve')}>Approve…</button>}
          {issue.status === 'approved' && can('send.approve') && <button className="btn primary" disabled={busy} onClick={() => setConfirm('schedule')}>Schedule</button>}
          {issue.status === 'scheduled' && can('send.approve') && <button className="btn danger" disabled={busy} onClick={() => act('unschedule', {}, 'Schedule cancelled')}>Unschedule</button>}
          {issue.archive_slug && issue.status === 'sent' && <a className="btn" href={`/archive/${issue.archive_slug}`} target="_blank" rel="noreferrer">Public archive ↗</a>}
        </PageHead>
        {issue.status === 'approved' && <div className="callout info" style={{ marginBottom: 16 }}>Approved. Any edit returns the issue to draft and needs approval again.</div>}
        {issue.ai_available === false && <div className="callout small" style={{ marginBottom: 16 }}>AI writing assist is off (no ANTHROPIC_API_KEY on the server), so summaries use template text. Set the key to get AI-drafted summaries and subject lines, clearly marked until a person accepts them.</div>}
        <Card title="Subject and preheader">
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label={`Subject (${head.subject.length}/70)`} id="sub"><input id="sub" className="i" disabled={!editable} value={head.subject} onChange={(e) => setHead({ ...head, subject: e.target.value })} /></Field>
            <Field label="Preheader" id="pre"><input id="pre" className="i" disabled={!editable} value={head.preheader} onChange={(e) => setHead({ ...head, preheader: e.target.value })} /></Field>
          </div>
          {issue.subject_options.length > 1 && editable && <div className="row small"><span className="muted">Suggestions:</span>{issue.subject_options.map((s) => <button key={s} className="btn sm" onClick={() => setHead({ ...head, subject: s })}>{s}</button>)}</div>}
          {editable && (head.subject !== (issue.subject || '') || head.preheader !== (issue.preheader || '')) && <button className="btn sm primary" style={{ marginTop: 8 }} disabled={busy} onClick={async () => setIssue(await run(() => api(`/newsletter/issues/${id}`, { method: 'PATCH', body: head }), 'Saved'))}>Save subject</button>}
        </Card>
        <div style={{ height: 16 }} />
        <Tabs value={tab} onChange={setTab} options={[['blocks', `Blocks (${issue.blocks.length})`], ['skipped', `Skipped items (${issue.skipped.length})`], ['preview', 'Preview & test'], ['checks', 'Checks'], ['discussion', `Comments & history`], ...(report.data ? [['report', 'Report']] : [])]} />
        {tab === 'blocks' && (
          <>
            {issue.blocks.map((b) => <BlockCard key={b.id} b={b} issue={issue} editable={editable} onSaved={(r, dir) => onBlock(r, dir, b)} />)}
            {editable && <button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={async () => setIssue(await run(() => api(`/newsletter/issues/${id}/blocks`, { method: 'POST', body: { title: 'New block', body: '' } })))}>+ Add custom block</button>}
          </>
        )}
        {tab === 'skipped' && (
          <Card title="Skipped items" sub="Collected but not publishable. People are never named without their consent to be featured.">
            {issue.skipped.length ? <table className="t"><thead><tr><th>Item</th><th>Type</th><th>Why skipped</th></tr></thead>
              <tbody>{issue.skipped.map((s) => <tr key={s.id}><td><b>{s.title}</b><div className="faint small">{s.summary}</div></td><td>{TYPE_LABEL[s.type]}</td><td><span className="badge bad">{s.skip_reason}</span></td></tr>)}</tbody></table>
              : <div className="empty">Nothing was skipped.</div>}
          </Card>
        )}
        {tab === 'preview' && (
          <Card title="Preview" actions={<>
            <Seg label="Width" value={mobile ? 'm' : 'd'} onChange={(v) => setMobile(v === 'm')} options={[['d', 'Desktop'], ['m', 'Mobile']]} />
            <a className="btn sm" href={`/api/newsletter/issues/${id}/preview?format=text`} target="_blank" rel="noreferrer">Plain text</a>
            {can('newsletter.edit') && <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/newsletter/issues/${id}/test`, { method: 'POST', body: {} }), 'Test sent to the seed list (see Dev inbox)')}>Send test to seed list</button>}
          </>}><EmailPreview html={html} mobile={mobile} /></Card>
        )}
        {tab === 'checks' && (
          <Card title="Pre-send checks" actions={<><button className="btn sm" disabled={busy} onClick={async () => setChecks(await run(() => api(`/newsletter/issues/${id}/checks`, { method: 'POST', body: {} })))}>Run checks</button><button className="btn sm" disabled={busy} onClick={async () => setChecks(await run(() => api(`/newsletter/issues/${id}/checks`, { method: 'POST', body: { live: true } })))}>With live link check</button></>}>
            {checks ? <Checks result={checks} /> : <div className="empty">Broken links, missing alt text, missing unsubscribe link, image weight over 1 MB, subject over 70 characters, unreviewed AI text.</div>}
          </Card>
        )}
        {tab === 'discussion' && (
          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <Card title="Comments">
              <ul className="list-plain">{issue.comments.map((c) => <li key={c.id}><b>{c.name || 'system'}</b> <span className="faint small">{fmtDateTime(c.created_at)}</span><div>{c.body}</div></li>)}</ul>
              {can('newsletter.edit') && <div className="row" style={{ marginTop: 8 }}><input className="i" aria-label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a note for the reviewer" style={{ flex: 1 }} />
                <button className="btn" disabled={!comment.trim() || busy} onClick={async () => { const r = await run(() => api(`/newsletter/issues/${id}/comments`, { method: 'POST', body: { body: comment } })); if (r) { setIssue(r); setComment(''); } }}>Post</button></div>}
            </Card>
            <Card title="Edit history" sub="Every edit with editor, time and before/after">
              {issue.edits.length ? <ul className="list-plain small">{issue.edits.map((e) => <li key={e.id}><b>{e.editor || 'system'}</b> changed <code>{e.field}</code> <span className="faint">{fmtDateTime(e.created_at)}</span>
                {e.before != null && <div className="faint" style={{ textDecoration: 'line-through', overflowWrap: 'anywhere' }}>{String(e.before).slice(0, 160)}</div>}
                {e.after != null && <div style={{ overflowWrap: 'anywhere' }}>{String(e.after).slice(0, 160)}</div>}</li>)}</ul> : <div className="empty">No edits yet.</div>}
            </Card>
          </div>
        )}
        {tab === 'report' && report.data && <SendReport r={{ ...report.data, blocks: report.data.blocks.map((b) => ({ ...b, block_id: b.name })) }} />}
        {confirm === 'regen' && <Confirm title="Regenerate the draft?" danger confirmLabel="Regenerate" busy={busy} onClose={() => setConfirm(null)} onConfirm={() => act('regenerate', {}, 'Draft regenerated')}
          text="The collectors run again and all blocks are rebuilt. Your edits to blocks in this issue will be replaced; the edit history keeps what was there." />}
        {confirm === 'approve' && <Confirm title="Approve this issue?" confirmLabel="Approve" busy={busy} onClose={() => setConfirm(null)} onConfirm={() => act('approve', { comment }, 'Approved')}
          text="The pre-send checks run first. After approval, any edit returns the issue to draft." />}
        {confirm === 'schedule' && <Confirm title="Schedule the issue?" confirmLabel="Schedule" busy={busy} onClose={() => setConfirm(null)} onConfirm={() => act('schedule', {}, 'Scheduled')}
          text={`It goes to everyone with newsletter consent whose preferred language is ${LANG_LABEL[issue.language]}, at ${fmtDateTime(issue.planned_send_at)}. Recipients are recalculated at send time, and a public archive copy is published when it is sent.`} />}
      </>
    )}</Async>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, useAction, useCan, fmtDate } from '../lib.jsx';
import { PageHead, Card, Async, Confirm } from '../ui.jsx';

function Side({ c }) {
  return (
    <div className="small">
      <div><Link to={`/audience/contacts/${c.id}`}><b>{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</b></Link> <span className="faint">#{c.id}</span></div>
      <div>{c.email || '—'}</div>
      <div className="faint">{c.phone || 'no phone'} · {c.type} · first touch {fmtDate(c.first_touch_at)}</div>
    </div>
  );
}

export default function Duplicates() {
  const can = useCan();
  const state = useApi('/contacts/duplicates');
  const [run, busy] = useAction();
  const [merge, setMerge] = useState(null);
  return (
    <>
      <PageHead title="Duplicate review" sub={<><Link to="/audience">← Contacts</Link> · Suggested matches by normalized email, then phone, then similar name. Merging keeps the earliest first touch, the full history and the most restrictive consent.</>} />
      <Async state={state}>{(rows) => (
        <Card title={`${rows.length} suggested merges`}>
          {rows.length ? (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Contact A</th><th>Contact B</th><th>Why</th><th /></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={`${r.a}-${r.b}`}>
                  <td><Side c={r.contactA} /></td><td><Side c={r.contactB} /></td>
                  <td><span className="badge info">{r.reason}</span><div className="faint small">score {r.score}</div></td>
                  <td className="nowrap">{can('contacts.edit') && <>
                    <button className="btn sm primary" onClick={() => setMerge(r)}>Merge…</button>{' '}
                    <button className="btn sm ghost" disabled={busy} onClick={async () => { if (await run(() => api('/contacts/duplicates/dismiss', { method: 'POST', body: { a: r.a, b: r.b } }), 'Marked as different people')) state.reload(); }}>Not the same</button>
                  </>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <div className="empty">No duplicates found.</div>}
        </Card>
      )}</Async>
      {merge && <Confirm title="Merge these contacts?" confirmLabel={`Keep #${merge.a}, merge #${merge.b} into it`} busy={busy} onClose={() => setMerge(null)}
        text={`#${merge.b} (${merge.contactB.email}) is merged into #${merge.a} (${merge.contactA.email}). Touchpoints, emails, events and outcomes move over; the earliest first touch is kept; any withdrawal on either record wins.`}
        onConfirm={async () => { if (await run(() => api('/contacts/merge', { method: 'POST', body: { keep: merge.a, drop: merge.b } }), 'Merged')) { setMerge(null); state.reload(); } }} />}
    </>
  );
}

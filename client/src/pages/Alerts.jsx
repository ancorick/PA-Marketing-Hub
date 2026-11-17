import { api, useApi, useAction, useSession, fmtDateTime } from '../lib.jsx';
import { PageHead, Card, Async, Status } from '../ui.jsx';

export default function Alerts() {
  const state = useApi('/alerts');
  const session = useSession();
  const [run] = useAction();
  return (
    <>
      <PageHead title="Alerts" sub="Guardrail pauses, failing data sources, provider warnings and newsletter drafts. When a Slack webhook is configured, alerts are posted there too." />
      <Async state={state}>{(rows) => (
        <Card>
          {rows.length ? <ul className="list-plain">{rows.map((a) => (
            <li key={a.id} className="row between" style={{ opacity: a.resolved_at ? 0.55 : 1, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
              <span className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}><Status value={a.level} /><span><div>{a.message}</div><div className="faint small">{a.kind} · {fmtDateTime(a.created_at)}{a.resolved_at && ` · resolved ${fmtDateTime(a.resolved_at)}`}</div></span></span>
              {!a.resolved_at && <button className="btn sm" onClick={async () => { if (await run(() => api(`/alerts/${a.id}/resolve`, { method: 'POST' }))) { state.reload(); session.refresh(); } }}>Resolve</button>}
            </li>
          ))}</ul> : <div className="empty">No alerts.</div>}
        </Card>
      )}</Async>
    </>
  );
}

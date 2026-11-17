import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, useAction, readFileText, fmtDateTime } from '../lib.jsx';
import { PageHead, Card, Async, Field } from '../ui.jsx';

const FIELDS = ['email', 'first_name', 'last_name', 'phone', 'language', 'type', 'course_family', 'tags', 'consent'];

export default function ImportPage() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [tags, setTags] = useState('');
  const [result, setResult] = useState(null);
  const [run, busy] = useAction();
  const batches = useApi('/imports');
  const body = (commit) => ({ csv: file.text, filename: file.name, mapping: mapping || undefined, commit, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) });
  const doPreview = async (m = mapping) => {
    const r = await run(() => api('/contacts/import', { method: 'POST', body: { ...body(false), mapping: m || undefined } }));
    if (r) { setPreview(r.preview); setMapping(r.preview.mapping); }
  };
  return (
    <>
      <PageHead title="Import contacts" sub={<><Link to="/audience">← Contacts</Link> · Preview first, then commit. Rows without a consent column are imported as unknown consent and receive no marketing email until consent is confirmed.</>} />
      <Card title="1. Choose a CSV file">
        <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={async (e) => { const f = e.target.files[0]; if (f) { setFile({ name: f.name, text: await readFileText(f) }); setPreview(null); setMapping(null); setResult(null); } }} />
        <Field label="Tags for every imported row (optional)" id="tags"><input id="tags" className="i" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. open-day-2026" /></Field>
        <button className="btn primary" disabled={!file || busy} onClick={() => doPreview(null)}>Preview import</button>
      </Card>
      {preview && (
        <>
          <Card title="2. Check the column mapping">
            <div className="grid grid-3" style={{ gap: 12 }}>
              {FIELDS.map((f) => (
                <Field key={f} label={f} id={`m-${f}`}>
                  <select id={`m-${f}`} className="i" value={mapping?.[f] ?? ''} onChange={(e) => { const m = { ...mapping }; if (e.target.value === '') delete m[f]; else m[f] = Number(e.target.value); setMapping(m); }}>
                    <option value="">— not imported —</option>{preview.header.map((h, i) => <option key={i} value={i}>{h}</option>)}
                  </select>
                </Field>
              ))}
            </div>
            <button className="btn" disabled={busy} onClick={() => doPreview(mapping)}>Refresh preview</button>
          </Card>
          <Card title="3. Preview">
            <div className="grid grid-4">
              <div className="tile"><div className="label">Rows</div><div className="value">{preview.total}</div></div>
              <div className="tile"><div className="label">New contacts</div><div className="value">{preview.new}</div></div>
              <div className="tile"><div className="label">Match existing</div><div className="value">{preview.matched}</div></div>
              <div className="tile"><div className="label">Invalid rows</div><div className="value">{preview.invalid.length}</div></div>
            </div>
            <div className="stack" style={{ marginTop: 12 }}>
              {preview.unknownConsent > 0 && <div className="callout warn">{preview.unknownConsent} rows have no consent value: they are imported with <b>unknown consent</b> and excluded from marketing sends until they confirm through a re-permission campaign.</div>}
              {preview.withdrawnKept > 0 && <div className="callout info">{preview.withdrawnKept} rows say "consent: yes" for people who unsubscribed earlier. The earlier withdrawal wins; the import cannot override it.</div>}
              {preview.duplicatesInFile > 0 && <div className="callout">{preview.duplicatesInFile} duplicate rows inside the file are skipped.</div>}
              {preview.invalid.length > 0 && <details><summary>Invalid rows</summary><ul className="small">{preview.invalid.slice(0, 50).map((r) => <li key={r.line}>Line {r.line}: {r.email || '(empty)'} — {r.error}</li>)}</ul></details>}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn primary" disabled={busy || !!result} onClick={async () => { const r = await run(() => api('/contacts/import', { method: 'POST', body: body(true) }), 'Import committed'); if (r) { setResult(r); batches.reload(); } }}>Commit import</button>
              {result && <span className="callout good">Created {result.created}, updated {result.updated} (batch #{result.batchId})</span>}
            </div>
          </Card>
        </>
      )}
      <Card title="Import history" sub="An import whose first send bounces above 10% is blocked until a manager reviews it.">
        <Async state={batches}>{(rows) => rows.length ? (
          <table className="t"><thead><tr><th>#</th><th>File</th><th>When</th><th className="num">Created</th><th className="num">Updated</th><th className="num">Invalid</th><th>Consent column</th><th>Status</th></tr></thead>
            <tbody>{rows.map((b) => <tr key={b.id}><td>{b.id}</td><td>{b.filename}</td><td className="small">{fmtDateTime(b.created_at)}</td><td className="num">{b.rows_created}</td><td className="num">{b.rows_updated}</td><td className="num">{b.rows_invalid}</td>
              <td>{b.has_consent_column ? 'yes' : <span className="badge warn">no — unknown consent</span>}</td><td>{b.blocked ? <span className="badge bad" title={b.blocked_reason}>blocked</span> : <span className="badge good">ok</span>}</td></tr>)}</tbody></table>
        ) : <div className="empty">No imports yet.</div>}</Async>
      </Card>
    </>
  );
}

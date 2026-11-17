import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) { if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`); return res.text(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('mh:signed-out'));
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.details);
  }
  return data;
}

export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) { setState({ data: null, error: null, loading: false }); return; }
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    api(path).then((data) => { if (n === seq.current) setState({ data, error: null, loading: false }); })
      .catch((error) => { if (n === seq.current) setState({ data: null, error, loading: false }); });
  }, [path, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

// ---------- Session ----------
export const SessionCtx = createContext(null);
export const useSession = () => useContext(SessionCtx);
export const useCan = () => { const s = useSession(); return (perm) => !!s?.permissions?.includes(perm); };

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, kind = 'info') => {
    const id = Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'bad' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">{items.map((i) => <div key={i.id} className={`toast ${i.kind}`}>{i.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// Run an action with toast feedback; returns the result or undefined on error.
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okText) => {
    setBusy(true);
    try { const r = await fn(); if (okText) toast(okText); return r; } catch (e) {
      const extra = e.details?.checks ? ': ' + e.details.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => c.message).join('; ') : '';
      toast(`${e.message}${extra}`, 'bad'); return undefined;
    } finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}

// ---------- Formatting ----------
const nf = new Intl.NumberFormat('en-US');
export const fmtNum = (v, digits) => {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return v; // suppressed small numbers ("fewer than 3")
  const d = digits ?? (Number.isInteger(v) ? 0 : 1);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
};
export const fmtAmd = (v) => (v == null ? '—' : typeof v === 'string' ? v : `${nf.format(Math.round(v))} AMD`);
export const fmtPct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
export const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (s) => (s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtMonth = (m) => { const [y, mo] = String(m).split('-'); return new Date(Date.UTC(+y, +mo - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }); };
export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
export const LANG_LABEL = { hy: 'Armenian', en: 'English', ru: 'Russian' };

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function useQueryState(defaults) {
  const read = () => { const p = new URLSearchParams(window.location.search); return Object.fromEntries(Object.keys(defaults).map((k) => [k, p.get(k) ?? defaults[k]])); };
  const [state, setState] = useState(read);
  const set = useCallback((patch) => setState((s) => {
    const n = { ...s, ...patch };
    const p = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(n)) { if (v === defaults[k] || v == null || v === '') p.delete(k); else p.set(k, v); }
    window.history.replaceState(null, '', `${window.location.pathname}${p.toString() ? '?' + p : ''}`);
    return n;
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  return [state, set];
}

export function readFileText(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsText(file); });
}
export function readFileDataUrl(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
}
export const useMemoJson = (v) => useMemo(() => v, [JSON.stringify(v)]); // eslint-disable-line react-hooks/exhaustive-deps

// Background jobs: send worker, nightly pipeline, newsletter collection, sunset,
// retention. Each job has a manual re-run in the UI (14.4).
import { one, run, now } from './db.js';
import { config } from './config.js';
import { workerTick, runSunsetPolicy } from './services/email/sending.js';
import { runAll, enforceRetention } from './services/analytics/pipeline.js';
import { createIssues, nextPlannedDate } from './services/newsletter.js';
import { getSetting, raiseAlert } from './lib/core.js';

function lastRun(job) { return one('SELECT value FROM settings WHERE key = ?', `job:${job}`)?.value?.replace(/"/g, ''); }
function markRun(job) { run(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, `job:${job}`, JSON.stringify(now()), now()); }
const due = (job, hours) => { const l = lastRun(job); return !l || Date.now() - new Date(l) > hours * 36e5; };

async function hourly() {
  try {
    // Nightly pipeline: finished by 07:00 Yerevan time (03:00 UTC) — NFR-F6.
    const h = new Date().getUTCHours();
    if (due('pipeline', 20) && h >= 1 && h <= 3) { await runAll({ label: 'scheduler' }); markRun('pipeline'); }
    if (due('retention', 24)) { enforceRetention(); markRun('retention'); }
    if (due('sunset', 24 * 7)) { runSunsetPolicy(); markRun('sunset'); }
    // Newsletter collection starts N days before the planned date (8.1 step 1).
    const c = getSetting('newsletter_cadence');
    const planned = nextPlannedDate();
    const collectAt = new Date(new Date(planned).getTime() - (c.collect_days_before || 5) * 864e5);
    const exists = one('SELECT 1 FROM issues WHERE substr(planned_send_at,1,10) = ?', planned.slice(0, 10));
    if (!exists && Date.now() >= collectAt.getTime()) {
      await createIssues({ planned_send_at: planned }, { label: 'scheduler' });
      raiseAlert('info', 'newsletter_draft', `Newsletter drafts for ${planned.slice(0, 10)} are ready for editing`);
    }
  } catch (e) { console.error('scheduled job failed', e); raiseAlert('warning', 'job_failed', `Scheduled job failed: ${e.message}`); }
}

export function startJobs() {
  const t1 = setInterval(() => workerTick(), config.workerTickMs);
  const t2 = setInterval(hourly, 15 * 60_000);
  setTimeout(hourly, 10_000);
  return () => { clearInterval(t1); clearInterval(t2); };
}

// Every 5 minutes: scheduled sends, newsletter auto-drafts, nightly pipeline,
// sunset policy and data retention. Runs only on the published production deploy.
import { handleScheduled, setSeedLoader } from '../../server/src/serverless/runtime.js';

setSeedLoader(async () => Buffer.from((await import('../generated/seed-snapshot.mjs')).default, 'base64'));

export default async () => {
  await handleScheduled();
};

export const config = { schedule: '*/5 * * * *' };

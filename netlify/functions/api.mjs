// All API calls and public pages (unsubscribe, preferences, sign-up, tracking,
// archive) run here. The React app itself is served as static files.
import { handleRequest, setSeedLoader } from '../../server/src/serverless/runtime.js';

setSeedLoader(async () => Buffer.from((await import('../generated/seed-snapshot.mjs')).default, 'base64'));

export default (req, context) => handleRequest(req, context);

export const config = {
  path: [
    '/api/*', '/u/*', '/p/*', '/confirm/*', '/t/*', '/l/*', '/uploads/*',
    '/archive', '/archive/*', '/signup', '/privacy', '/stay-subscribed', '/healthz',
  ],
};

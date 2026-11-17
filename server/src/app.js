// Express application (no listen) so tests can mount it.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ROOT, UPLOAD_DIR } from './config.js';
import { securityHeaders, errorHandler } from './lib/http.js';
import { authenticate } from './lib/auth.js';
import { router as integrations } from './routes/integrations.js';
import { router as publicRoutes } from './routes/public.js';
import { router as api } from './routes/api.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(securityHeaders);
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  // Signed webhooks need the raw body; mount before any JSON parser.
  app.use('/api', integrations);
  app.use(publicRoutes);
  app.use(authenticate);
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: false }));
  // Built frontend (client/dist) with SPA fallback.
  const dist = path.resolve(ROOT, '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (req, res) => res.type('text').send('Marketing Hub API is running. Build the client (npm run build) or start it with npm run dev:client.'));
  }
  app.use(errorHandler);
  return app;
}

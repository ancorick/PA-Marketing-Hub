import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API, public pages and tracking links are served by the
// Express server on :4000; everything else is the React app.
const backend = 'http://localhost:4000';
const proxied = ['/api', '/u/', '/p/', '/confirm', '/signup', '/t/', '/l/', '/archive', '/privacy', '/uploads', '/stay-subscribed', '/healthz'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: backend, changeOrigin: false }])),
  },
  build: { outDir: 'dist', sourcemap: false },
});

import { config } from './config.js';
import { openDb, one } from './db.js';
import { createApp } from './app.js';
import { startJobs } from './jobs.js';

openDb();
if (!one('SELECT COUNT(*) n FROM users').n) {
  console.log('Database is empty. Seeding demo data first (npm run seed)...');
  const { seed } = await import('./seed/index.js');
  await seed();
}
const app = createApp();
app.listen(config.port, () => {
  console.log(`Marketing Hub running at ${config.baseUrl} (ESP adapter: ${config.espAdapter})`);
});
startJobs();

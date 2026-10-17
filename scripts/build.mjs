import { mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist');
for (const file of ['index.html', 'style.css', 'app.js', 'proof-worker.js']) await copyFile(`public/${file}`, `dist/${file}`);
console.log('Built static assets into dist/');

// Only the private build workspace receives the scheduler credential.
const config = JSON.parse(await readFile('edgeone.json', 'utf8'));
const task = config.schedules.find(task => task.name === 'daily-cleanup');
delete task.payload;
const cleanupSecret = process.env.CLEANUP_SECRET;
if (cleanupSecret) {
  if (cleanupSecret.length < 32) throw new Error('CLEANUP_SECRET must contain at least 32 characters.');
  task.payload = { token: cleanupSecret };
  console.log('Native cleanup schedule: credential configured (value hidden).');
} else if (process.env.SITE_SECRET) {
  throw new Error('Set CLEANUP_SECRET before deploying the native cleanup schedule.');
} else {
  console.log('Native cleanup schedule: template only; no deployment credential configured.');
}
await writeFile('edgeone.json', JSON.stringify(config, null, 2) + '\n');

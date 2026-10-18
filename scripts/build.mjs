import { mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist');
for (const file of ['index.html', 'style.css', 'theme.js', 'code-input.js', 'app.js', 'proof-worker.js']) await copyFile(`public/${file}`, `dist/${file}`);
console.log('Built static assets into dist/');

// Pair the scheduler with this deployment's server-only credential. Never use it for user tickets.
const config = JSON.parse(await readFile('edgeone.json', 'utf8'));
const task = config.schedules.find(task => task.name === 'daily-cleanup');
const { randomBytes } = await import('node:crypto');
const token = randomBytes(32).toString('hex');
task.payload = { token };
await mkdir('lib', { recursive: true });
await writeFile('lib/generated-schedule.js', `export const scheduleToken = ${JSON.stringify(token)};\n`, { mode: 0o600 });
await writeFile('edgeone.json', JSON.stringify(config, null, 2) + '\n');
console.log('Native cleanup schedule: automatic deployment credential configured (value hidden).');

import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';

const server = await createServer();
await server.listen();
server.printUrls();
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, AI_WATCH_DEV_URL: 'http://127.0.0.1:5173' } });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

/**
 * docker-guard entrypoint. Reads its configuration from the environment,
 * listens on a unix socket shared only with the worker, and forwards allowed
 * calls to the real Docker socket.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createGuardServer } from './server.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`docker-guard: ${name} must be set\n`);
    process.exit(2);
  }
  return value;
}

const listen = process.env.LISTEN ?? '/run/guard/docker.sock';
const server = createGuardServer({
  trialImage: required('TRIAL_IMAGE'),
  trialVolume: required('TRIAL_VOLUME'),
  trialNetworks: required('TRIAL_NETWORKS')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
  upstreamSocket: process.env.DOCKER_SOCK ?? '/var/run/docker.sock',
});

mkdirSync(dirname(listen), { recursive: true });
if (existsSync(listen)) unlinkSync(listen);
server.listen(listen, () => {
  // Only the worker mounts this volume; it runs as a different uid.
  chmodSync(listen, 0o666);
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), msg: 'docker-guard listening', listen })}\n`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

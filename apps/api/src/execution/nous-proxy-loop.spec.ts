/**
 * What nous-proxy's loop does in each state of the nous-home volume (Phase 8
 * G6 and its review): the entrypoint is taken from docker-compose.yml and run
 * by /bin/sh, with Hermes, the clock and the 5 s sleep swapped for stubs
 * that write one log. A proxy start writes `start`, each pause `sleep`; the
 * sleep stub ends the loop after a set number of passes, so no outcome here
 * depends on timing.
 *
 * The auth store outlives the login: Disconnect (nous-login.py, Hermes's
 * logout_command, clear_provider_auth) rewrites auth.json with no provider,
 * and `hermes proxy start` then exits at once. The loop cannot tell that
 * from a login without reading the file, so it goes by how long the proxy
 * ran: a start that ends within 30 s waits for the auth store to change, or
 * for 60 passes (5 minutes). The auth.json files here are written by the
 * test; the loop only ever checks the file's existence and time.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const COMPOSE = fileURLToPath(new URL('../../../../docker-compose.yml', import.meta.url));

/** What Disconnect leaves: Hermes's auth store with no provider in it. */
const DISCONNECTED = '{"version":1,"providers":{},"active_provider":null}';
/** A stand-in for a login: the loop never reads the content. */
const LOGGED_IN = '{"version":1,"providers":{"nous":{}},"active_provider":"nous"}';

/** Passes between two tries after a quick exit: the try's own, then 60 idle ones. */
const RETRY_PASSES = 61;

/**
 * Hermes: logs the start, moves the fake clock on by the start's entry in
 * PROXY_SECONDS (the last entry for every later start), and exits as the
 * proxy does without a login.
 */
const HERMES_STUB = `#!/bin/sh
echo start >> "$LOOP_LOG"
n=$(grep -c start "$LOOP_LOG")
for s in $PROXY_SECONDS; do seconds=$s; n=$((n - 1)); [ "$n" -gt 0 ] || break; done
echo $(( $(cat "$LOOP_CLOCK") + seconds )) > "$LOOP_CLOCK"
exit 2
`;

/** The 5 s pause: logs it, rewrites the auth store on pass CONNECT_AT, and stops the loop after PASSES. */
const SLEEP_STUB = `#!/bin/sh
echo sleep >> "$LOOP_LOG"
n=$(grep -c sleep "$LOOP_LOG")
if [ "$n" = "$CONNECT_AT" ]; then touch -t 203001010000 "$HERMES_HOME/auth.json"; fi
if [ "$n" -ge "$PASSES" ]; then kill -TERM "$PPID"; fi
exit 0
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nous-proxy-loop-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The loop as /bin/sh gets it: Compose turns $$ into $. */
async function composeLoop(): Promise<string> {
  const compose = parse(await readFile(COMPOSE, 'utf8')) as {
    services: Record<string, { entrypoint?: string[] }>;
  };
  const [shell, flag, script] = compose.services['nous-proxy']!.entrypoint!;
  expect([shell, flag]).toEqual(['/bin/sh', '-c']);
  return script!.replaceAll('$$', '$');
}

/** Replaces every `from`, which must be there: a stub that replaces nothing tests nothing. */
function swap(script: string, from: string, to: string): string {
  expect(script).toContain(from);
  return script.replaceAll(from, to);
}

interface LoopRun {
  /** The volume's auth store, or none. */
  auth?: string;
  /** Seconds each proxy start takes on the fake clock, in order; the last for every later one. */
  proxySeconds: number[];
  /** Passes (pauses) before the loop is stopped. */
  passes: number;
  /** The pause after which a Connect rewrites the auth store. */
  connectAt?: number;
  /** A stamp left by an earlier life of the container, newer than the auth store. */
  staleStamp?: boolean;
}

/** Runs the loop to its end and returns the log: `start` and `sleep` lines in order. */
async function runLoop(run: LoopRun): Promise<string[]> {
  const home = join(dir, 'home');
  const stamp = join(dir, 'proxy-exited');
  const log = join(dir, 'log');
  const clock = join(dir, 'clock');
  await writeFile(join(dir, 'hermes'), HERMES_STUB);
  await writeFile(join(dir, 'sleep'), SLEEP_STUB);
  await chmod(join(dir, 'hermes'), 0o755);
  await chmod(join(dir, 'sleep'), 0o755);
  await writeFile(log, '');
  await writeFile(clock, '1000\n');
  await mkdir(home);
  if (run.auth !== undefined) {
    await writeFile(join(home, 'auth.json'), run.auth);
    // An hour old, so a stamp written now is newer.
    const hourAgo = new Date(Date.now() - 3_600_000);
    await utimes(join(home, 'auth.json'), hourAgo, hourAgo);
  }
  if (run.staleStamp) await writeFile(stamp, '');

  let script = await composeLoop();
  script = swap(script, '/opt/hermes/.venv/bin/hermes', join(dir, 'hermes'));
  script = swap(script, '/tmp/proxy-exited', stamp);
  script = swap(script, 'date +%s', 'cat "$LOOP_CLOCK"');
  script = swap(script, 'sleep 5 &', `${join(dir, 'sleep')} &`);

  const child = spawn('/bin/sh', ['-c', script], {
    env: {
      PATH: process.env.PATH,
      HERMES_HOME: home,
      LOOP_LOG: log,
      LOOP_CLOCK: clock,
      PROXY_SECONDS: run.proxySeconds.join(' '),
      PASSES: String(run.passes),
      CONNECT_AT: String(run.connectAt ?? 0),
    },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    // Only a loop that never reaches its last pass gets here.
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the loop did not finish ${run.passes} passes`));
    }, 30_000);
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      clearTimeout(deadline);
      resolve(exitCode);
    });
  });
  // The TERM trap ends the loop with 0.
  expect(code).toBe(0);
  return (await readFile(log, 'utf8')).split('\n').filter(Boolean);
}

/** `count` pauses. */
const sleeps = (count: number): string[] => Array<string>(count).fill('sleep');

describe('nous-proxy loop (Phase 8 G6)', () => {
  it('never starts Python while the volume holds no auth store', async () => {
    expect(await runLoop({ proxySeconds: [0], passes: 70 })).toEqual(sleeps(70));
  });

  it('starts the proxy for a login, and again 5 s after a run of 30 s or more ends', async () => {
    expect(await runLoop({ auth: LOGGED_IN, proxySeconds: [30], passes: 3 })).toEqual([
      'start',
      'sleep',
      'start',
      'sleep',
      'start',
      'sleep',
    ]);
  });

  it.each([0, 29])(
    'after a Disconnect, a proxy that exits within 30 s (%i s) is tried again only every 5 minutes',
    async (proxySeconds) => {
      const passes = 2 * RETRY_PASSES + 1;
      expect(await runLoop({ auth: DISCONNECTED, proxySeconds: [proxySeconds], passes })).toEqual([
        'start',
        ...sleeps(RETRY_PASSES),
        'start',
        ...sleeps(RETRY_PASSES),
        'start',
        'sleep',
      ]);
    },
  );

  it('after a retry that serves 30 s or more, starts the proxy again 5 s after it ends', async () => {
    // A login whose first start failed at once (the portal was down, say): the retry serves.
    const passes = RETRY_PASSES + 2;
    expect(await runLoop({ auth: LOGGED_IN, proxySeconds: [0, 30], passes })).toEqual([
      'start',
      ...sleeps(RETRY_PASSES),
      'start',
      'sleep',
      'start',
      'sleep',
    ]);
  });

  it('starts the proxy on the pass after a Connect rewrites the auth store', async () => {
    expect(
      await runLoop({ auth: DISCONNECTED, proxySeconds: [0], passes: 7, connectAt: 5 }),
    ).toEqual(['start', ...sleeps(5), 'start', 'sleep', 'start', 'sleep']);
  });

  it('tries once on each start of the container, whatever stamp an earlier one left', async () => {
    expect(
      await runLoop({ auth: DISCONNECTED, proxySeconds: [0], passes: 3, staleStamp: true }),
    ).toEqual(['start', ...sleeps(3)]);
  });
});

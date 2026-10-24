/**
 * Presence against a real (PGlite) database: the row a worker start inserts,
 * the heartbeat, the stop, and every way it degrades without throwing.
 * Listing toolsets and inspecting the image need the sandbox; both are
 * replaced here, and toolsets.spec.ts runs the real listing.
 */
import { hostname } from 'node:os';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { HERMES_REVISION, HERMES_VERSION } from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import type { Env } from '../../config/env.js';
import { DB, unconfiguredDb } from '../../database/db.provider.js';
import { workers } from '../../database/schema/index.js';
import { WorkerSandboxSchema } from '../../database/schema/worker-sandbox.js';
import type { AppDb } from '../../database/types.js';
import { findLiveWorker } from '../../queue/live-worker.js';
import { SandboxService, type SandboxState } from '../../sandbox/sandbox.service.js';
import type { SelfTestCheck } from '../../sandbox/self-test.js';
import { listToolsets } from '../../sandbox/toolsets.js';
import { SANDBOX_UNAVAILABLE_ERROR } from './presence-report.js';
import { inspectTrialImage } from './trial-image.js';
import { HEARTBEAT_INTERVAL_MS, WorkerPresenceService } from './worker-presence.service.js';

vi.mock('../../sandbox/toolsets.js', () => ({ listToolsets: vi.fn() }));
vi.mock('./trial-image.js', () => ({ inspectTrialImage: vi.fn() }));

const IMAGE = 'hermes-evals/trial:v0.22.4-4d04303';
const IMAGE_ID = `sha256:${'7'.repeat(64)}`;
const SECRET_NAME = 'B5_PRESENCE_TEST_TOKEN';
const SECRET_VALUE = 'presence-secret-value-0042';

const CHECKS: SelfTestCheck[] = [
  { name: 'runs as uid 10000', ok: true, detail: 'uid 10000' },
  { name: 'has no default route', ok: true, detail: 'no default route' },
];

// PGlite databases are slow to create when every test file runs at once.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let t: TestDatabase;
let settings: Record<string, unknown>;
let egressNames: () => Promise<string[]>;
let sandboxState: SandboxState;

const config = { get: (key: string) => settings[key] } as unknown as ConfigService<Env, true>;
/** The PinoLogger calls presence makes, recorded. */
const logger = () => ({
  setContext: vi.fn(),
  info: vi.fn(),
  warn: vi.fn<(context: unknown, message: string) => void>(),
  debug: vi.fn(),
  error: vi.fn(),
});
const sandbox = () =>
  ({
    status: () => ({ state: sandboxState, checks: sandboxState === 'unavailable' ? [] : CHECKS }),
    egress: { envNames: () => egressNames() },
    engine: {},
    trialsDir: '/trials',
    image: IMAGE,
    volume: 'hermes-evals-trials',
    slots: ['hermes-evals-trial-0', 'hermes-evals-trial-1', 'hermes-evals-trial-2', 'trial-3'],
  }) as unknown as SandboxService;

const presence = (db: AppDb = t.db, log = logger()) =>
  new WorkerPresenceService(db, config, sandbox(), log as unknown as PinoLogger);

const rows = () => t.db.select().from(workers);

const WAIT = { timeout: 10_000, interval: 50 };

/** Fires heartbeats until `assertion` holds; a beat fired while one is in flight does nothing. */
const beatUntil = (assertion: () => Promise<void>) =>
  vi.waitFor(async () => {
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    await assertion();
  }, WAIT);

beforeEach(async () => {
  t = await createTestDatabase();
  settings = {
    DATABASE_URL: 'postgres://unused',
    WORKER_CONCURRENCY: 3,
    DOCKER_SOCKET: '/run/guard/docker.sock',
  };
  egressNames = async () => ['VENDOR_API_TOKEN'];
  sandboxState = 'isolated';
  vi.mocked(listToolsets).mockReset().mockResolvedValue(['web', 'terminal', 'file']);
  vi.mocked(inspectTrialImage)
    .mockReset()
    .mockResolvedValue({ id: IMAGE_ID, revision: HERMES_REVISION });
  process.env[SECRET_NAME] = SECRET_VALUE;
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env[SECRET_NAME];
  await t.close();
});

describe('WorkerPresenceService.start', () => {
  it('inserts the worker row with its facts and names, never a value', async () => {
    const service = presence();
    await service.start();
    const [row] = await rows();
    expect(row).toMatchObject({
      id: service.id,
      hostname: hostname(),
      concurrency: 3,
      // Its own TRIAL_SLOTS, which differ from its concurrency.
      slots: 4,
      inFlight: 0,
      hermesVersion: HERMES_VERSION,
      hermesRevision: HERMES_REVISION,
      toolsets: ['web', 'terminal', 'file'],
      egressEnvNames: ['VENDOR_API_TOKEN'],
      stoppedAt: null,
    });
    expect(row!.envNames).toContain(SECRET_NAME);
    expect(row!.envNames).toEqual([...row!.envNames].sort());
    expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);
    const report = WorkerSandboxSchema.parse(row!.sandbox);
    expect(report).toMatchObject({
      state: 'isolated',
      image: IMAGE,
      image_digest: IMAGE_ID,
      revision: HERMES_REVISION,
      trigger: 'worker start',
    });
    expect(report.checks.map((c) => c.id)).toEqual(['unprivileged-user', 'no-default-route']);
    expect(vi.mocked(listToolsets)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(inspectTrialImage)).toHaveBeenCalledWith('/run/guard/docker.sock', IMAGE);
    expect((await findLiveWorker(t.db))?.id).toBe(service.id);
    await service.stop();
  });

  it('reports no toolsets and why when the sandbox is unavailable, without touching it', async () => {
    sandboxState = 'unavailable';
    egressNames = () => Promise.reject(new Error('connect ENOENT /run/egress/admin.sock'));
    const log = logger();
    const service = presence(t.db, log);
    await service.start();
    const [row] = await rows();
    expect(row).toMatchObject({ toolsets: [], egressEnvNames: [] });
    expect(row!.sandbox).toMatchObject({
      state: 'unavailable',
      checks: [],
      error: SANDBOX_UNAVAILABLE_ERROR,
    });
    expect(row!.sandbox).not.toHaveProperty('image_digest');
    expect(vi.mocked(listToolsets)).not.toHaveBeenCalled();
    expect(vi.mocked(inspectTrialImage)).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringMatching(/egress env names/),
    );
    await service.stop();
  });

  it('still registers when listing toolsets or inspecting the image fails', async () => {
    vi.mocked(listToolsets).mockRejectedValue(new Error('hermes tools list exited 1'));
    vi.mocked(inspectTrialImage).mockRejectedValue(new Error('inspect: 403'));
    sandboxState = 'failed';
    const service = presence();
    await service.start();
    const [row] = await rows();
    expect(row!.toolsets).toEqual([]);
    expect(row!.sandbox).toMatchObject({ state: 'failed', revision: HERMES_REVISION });
    expect(row!.sandbox).not.toHaveProperty('image_digest');
    await service.stop();
  });

  it('does nothing when the database is not configured', async () => {
    settings.DATABASE_URL = undefined;
    const service = presence(unconfiguredDb());
    await expect(service.start()).resolves.toBeUndefined();
    expect(service.id).toBeNull();
    expect(vi.mocked(listToolsets)).not.toHaveBeenCalled();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('retries a failed registration on the next beat instead of throwing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Violates workers_concurrency_ck, as a database refusing the insert would.
    settings.WORKER_CONCURRENCY = 0;
    const log = logger();
    const service = presence(t.db, log);
    await service.start();
    expect(service.id).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'worker registration failed');
    settings.WORKER_CONCURRENCY = 3;
    await beatUntil(async () => expect(await rows()).toHaveLength(1));
    expect(service.id).toBe((await rows())[0]!.id);
    await service.stop();
  });
});

describe('the heartbeat', () => {
  it('renews the row every 10 s with fresh names, and stops on stop()', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const service = presence();
    await service.start();
    const id = service.id!;
    const old = new Date(Date.now() - 120_000);
    await t.db.update(workers).set({ lastHeartbeatAt: old }).where(eq(workers.id, id));
    expect(await findLiveWorker(t.db)).toBeNull();

    egressNames = async () => ['OPENROUTER_API_KEY', 'VENDOR_API_TOKEN'];
    delete process.env[SECRET_NAME];
    await beatUntil(async () => {
      const [row] = await rows();
      expect(row!.egressEnvNames).toEqual(['OPENROUTER_API_KEY', 'VENDOR_API_TOKEN']);
    });
    const [renewed] = await rows();
    expect(renewed!.lastHeartbeatAt.getTime()).toBeGreaterThan(old.getTime());
    expect(renewed!.envNames).not.toContain(SECRET_NAME);
    expect((await findLiveWorker(t.db))?.id).toBe(id);

    await service.stop();
    await service.stop();
    const [stopped] = await rows();
    expect(stopped!.stoppedAt).not.toBeNull();
    expect(await findLiveWorker(t.db)).toBeNull();

    // No beat after stop: the row stays as stop() left it.
    egressNames = async () => ['AFTER_STOP'];
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await rows())[0]!.egressEnvNames).toEqual(['OPENROUTER_API_KEY', 'VENDOR_API_TOKEN']);
  });

  it('reports no egress names while egress is down, and logs that once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const log = logger();
    const service = presence(t.db, log);
    await service.start();
    egressNames = () => Promise.reject(new Error('egress GET /env-names timed out'));
    // At least two failing beats: each renews the row, only the first logs.
    for (let beat = 0; beat < 2; beat += 1) {
      await t.db.update(workers).set({ lastHeartbeatAt: sql`now() - interval '1 hour'` });
      await beatUntil(async () => expect(await findLiveWorker(t.db)).not.toBeNull());
    }
    expect((await rows())[0]!.egressEnvNames).toEqual([]);
    const egressWarnings = log.warn.mock.calls.filter(([, msg]) => /egress env names/.test(msg));
    expect(egressWarnings).toHaveLength(1);
    await service.stop();
  });
});

describe('in a Nest module', () => {
  it('marks the worker stopped when the module closes', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkerPresenceService,
        { provide: DB, useValue: t.db },
        { provide: ConfigService, useValue: config },
        { provide: SandboxService, useValue: sandbox() },
        { provide: PinoLogger, useValue: logger() },
      ],
    }).compile();
    await moduleRef.init();
    await moduleRef.get(WorkerPresenceService).start();
    expect(await findLiveWorker(t.db)).not.toBeNull();
    await moduleRef.close();
    const [row] = await rows();
    expect(row!.stoppedAt).not.toBeNull();
  });
});

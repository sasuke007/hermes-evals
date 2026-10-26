/**
 * Test helpers for the attempt runner specs: a temporary trials volume and
 * data directory with real blobs and a stored skill, an AttemptPlan that
 * points at them, an in-memory AttemptSink, and a runner on FakeEngine and
 * FakeEgress with the plan's times shortened. The name ends in `-spec.ts`, so
 * the build leaves it out, and not in `.spec.ts`, so vitest does not run it.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchRecord } from '@hermes-evals/shared';
import {
  FakeEgress,
  FakeEngine,
  type FakeContainerInfo,
  type FakeEgressOptions,
  type FakeTrialScript,
} from '../../../test/support/fake-engine.js';
import { newId } from '../../database/ids.js';
import { skillContentHash } from '../../resources/skills/skill-files.js';
import { BlobStore } from '../../storage/blob-store.js';
import {
  LeaseLostError,
  type AttemptEventInput,
  type AttemptPlan,
  type AttemptSink,
} from '../contracts.js';
import { TrialAttemptRunner } from './runner.js';
import type { AttemptRunnerSettings } from './settings.js';

export const IMAGE = 'hermes-evals/trial:v0.22.4-4d04303';
export const VOLUME = 'hermes-evals-trials';
export const SLOT = 'hermes-evals-trial-0';
export const GUARD = { trialImage: IMAGE, trialVolume: VOLUME, trialNetworks: [SLOT] };
export const DAEMON = 'FAKE:DAEMON:1';

export const FIXTURE_CSV = 'invoice_no,vendor,amount\nINV-1,Acme,100.00\nINV-2,Beta,942.00\n';
export const POLICY_DOC = 'Refunds over 500 need approval.\n';
export const SKILL_MD =
  '---\nname: invoice-audit\nversion: 1.0.0\ndescription: Audit invoices\n---\nCheck totals.\n';

const sha = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

/** An in-memory AttemptSink: what the runner wrote, in order, and switches to fail it. */
export class MemorySink implements AttemptSink {
  /** Every call in order: `launch`, `container`, `events <n>`, `cancel?`. */
  readonly calls: string[] = [];
  launch: LaunchRecord | null = null;
  container: { id: string; hostId: string } | null = null;
  readonly events: Array<AttemptEventInput & { seq: number }> = [];
  readonly batches: number[] = [];
  cancel = false;
  /** When set, every call from then on throws LeaseLostError. */
  leaseLost = false;
  /** Throw LeaseLostError from the n-th appendEvents call (1-based). */
  loseLeaseOnAppend: number | null = null;
  loseLeaseOnLaunch = false;

  constructor(private readonly attemptId: string) {}

  private fence(): void {
    if (this.leaseLost) throw new LeaseLostError(this.attemptId);
  }

  async recordLaunch(record: LaunchRecord): Promise<void> {
    this.calls.push('launch');
    if (this.loseLeaseOnLaunch) this.leaseLost = true;
    this.fence();
    this.launch = JSON.parse(JSON.stringify(record)) as LaunchRecord;
  }

  async recordContainer(id: string, hostId: string): Promise<void> {
    this.calls.push('container');
    this.fence();
    this.container = { id, hostId };
  }

  async appendEvents(events: readonly AttemptEventInput[]): Promise<void> {
    this.calls.push(`events ${events.length}`);
    if (this.loseLeaseOnAppend !== null && this.batches.length + 1 >= this.loseLeaseOnAppend) {
      this.leaseLost = true;
    }
    this.fence();
    this.batches.push(events.length);
    for (const event of events) {
      this.events.push({ ...JSON.parse(JSON.stringify(event)), seq: this.events.length + 1 });
    }
  }

  async cancelRequested(): Promise<boolean> {
    this.fence();
    return this.cancel;
  }
}

export interface AttemptWorld {
  base: string;
  trialsDir: string;
  dataDir: string;
  blobs: BlobStore;
  skillsDir: string;
  fixtureSha: string;
  docSha: string;
  skillHash: string;
  /** A fresh plan (new attempt and run ids) pointing at this world, with overrides. */
  plan(overrides?: PlanOverrides): AttemptPlan;
  cleanup(): Promise<void>;
}

export interface PlanOverrides {
  configuration?: Partial<AttemptPlan['configuration']>;
  limits?: Partial<AttemptPlan['limits']>;
  task?: Partial<AttemptPlan['task']>;
}

export async function createAttemptWorld(): Promise<AttemptWorld> {
  const base = await mkdtemp(join(tmpdir(), 'attempt-runner-'));
  const trialsDir = join(base, 'trials');
  const dataDir = join(base, 'data');
  const skillsDir = join(dataDir, 'skills');
  await mkdir(trialsDir);
  await mkdir(skillsDir, { recursive: true });
  const blobs = new BlobStore(dataDir);
  const fixture = await blobs.putBuffer(Buffer.from(FIXTURE_CSV));
  const doc = await blobs.putBuffer(Buffer.from(POLICY_DOC));
  const skillFiles = [
    { path: 'SKILL.md', content: SKILL_MD },
    { path: 'scripts/check.py', content: 'print("ok")\n' },
  ];
  const skillHash = skillContentHash(
    skillFiles.map((f) => ({ path: f.path, sha256: sha(f.content) })),
  );
  for (const file of skillFiles) {
    const target = join(skillsDir, skillHash, file.path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, file.content);
  }
  const plan = (overrides: PlanOverrides = {}): AttemptPlan => {
    const attemptId = newId();
    const root = join(trialsDir, attemptId);
    return {
      experimentId: newId(),
      runId: newId(),
      attemptId,
      attemptNumber: 1,
      token: createHash('sha256').update(attemptId).digest('hex'),
      slot: SLOT,
      paths: { root, home: join(root, 'home'), workspace: join(root, 'workspace') },
      task: {
        id: newId(),
        key: 'total_due',
        prompt: 'Report the total of invoices.csv in a fenced JSON block.\n',
        fixtures: [{ path: 'invoices.csv', sha256: fixture.sha256, size: fixture.size }],
        homeSeeds: [],
        ...overrides.task,
      },
      limits: { maxTurns: 6, runBudgetS: 30, ...overrides.limits },
      configuration: {
        versionId: newId(),
        name: 'with-skill',
        version: 1,
        model: 'mock/scripted',
        provider: 'custom',
        baseUrl: 'http://mock-model:8090/v1',
        toolsets: ['file', 'terminal'],
        memoryEnabled: false,
        skills: [{ id: newId(), name: 'invoice-audit', version: '1.0.0', contentHash: skillHash }],
        skillLoading: 'preload',
        documents: [{ id: newId(), filename: 'policy.md', sha256: doc.sha256 }],
        mcpServers: [],
        ...overrides.configuration,
      },
      hermes: { version: '0.22.4', revision: '4d04303818b61bf3aa09278af48356315515965b' },
    };
  };
  return {
    base,
    trialsDir,
    dataDir,
    blobs,
    skillsDir,
    fixtureSha: fixture.sha256,
    docSha: doc.sha256,
    skillHash,
    plan,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/** Times shortened so a deadline, a cancel or a flush happens within a test. */
export const FAST_SETTINGS: Partial<AttemptRunnerSettings> = {
  deadlineGraceS: 0,
  stopGraceS: 0,
  disk: { maxBytes: 2 * 1024 * 1024 * 1024, maxEntries: 50_000, intervalMs: 25 },
  flushIntervalMs: 20,
  cancelPollMs: 20,
};

export interface RunnerKit {
  engine: FakeEngine;
  egress: FakeEgress;
  runner: TrialAttemptRunner;
}

export function runnerKit(
  world: AttemptWorld,
  script: (info: FakeContainerInfo) => FakeTrialScript,
  options: {
    env?: NodeJS.ProcessEnv;
    settings?: Partial<AttemptRunnerSettings>;
    egress?: FakeEgressOptions;
  } = {},
): RunnerKit {
  const engine = new FakeEngine({
    trialsDir: world.trialsDir,
    guard: GUARD,
    script,
    daemonId: DAEMON,
  });
  const egress = new FakeEgress(options.egress);
  const runner = new TrialAttemptRunner({
    engine,
    egress,
    blobs: world.blobs,
    skillsDir: world.skillsDir,
    image: IMAGE,
    volume: VOLUME,
    hostId: DAEMON,
    env: options.env ?? {},
    settings: { ...FAST_SETTINGS, ...options.settings },
  });
  return { engine, egress, runner };
}

/** Every regular file under `dir`, relative path to content, read synchronously (for a script hook). */
export function snapshotTree(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(full);
    if (stat.isDirectory()) Object.assign(out, snapshotTree(full, rel));
    else if (stat.isFile()) out[rel] = readFileSync(full, 'utf8');
  }
  return out;
}

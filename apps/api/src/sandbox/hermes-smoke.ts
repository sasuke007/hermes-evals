/**
 * One real Hermes run inside a trial container, driven by the scripted mock
 * model behind the model gateway. It exercises the whole launch contract:
 * hardened container, config.yaml in the home, prompt file, attempt token
 * instead of a real key, stream-json events on stdout, tools running inside
 * the sandbox, egress usage accounting, and removal at the end.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { newId } from '../database/ids.js';
import {
  newAttemptToken,
  type EgressClient,
  type EgressLogEntry,
  type EgressUsage,
} from './egress-client.js';
import type { EngineClient } from './engine-client.js';
import { DEFAULT_DISK_LIMIT, readTrialFile, walkTrialTree } from './trial-files.js';
import { prepareTrialDirs, runTrial, type TrialOutcome } from './trial-runner.js';
import { TRIAL_HOME, TRIAL_WORKSPACE } from './trial-spec.js';

export interface SmokeDeps {
  engine: EngineClient;
  egress: EgressClient;
  trialsDir: string;
  image: string;
  volume: string;
  slot: string;
  /** Gateway upstream name and model the run uses. */
  provider: string;
  model: string;
  hermesProvider: string;
  deadlineMs?: number;
}

export interface SmokeReport {
  attemptId: string;
  outcome: TrialOutcome;
  events: Array<Record<string, unknown>>;
  nonJsonLines: string[];
  stderrTail: string;
  usage: EgressUsage | null;
  egressLog: EgressLogEntry[];
  homeFiles: string[];
  /** Home files that contain the attempt token; empty when none does. */
  tokenInHome: string[];
  /** Home files too large or too odd to search for the token. */
  tokenUnchecked: string[];
  /** The `result` event's text, or null when Hermes produced no result. */
  finalText: string | null;
}

/** What one trial runs: the prompt, the files placed in the workspace, and its limits. */
export interface HermesTrialInput {
  prompt: string;
  /** Relative paths in the workspace and their content. */
  fixtures: Array<{ path: string; content: Buffer | string }>;
  toolsets: string[];
  maxTurns: number;
  budgetSeconds: number;
  deadlineMs: number;
  /** Gateway token budget for the attempt: the agent holds its token and could call the model directly. */
  maxTokens: number;
}

const SMOKE_INPUT: Omit<HermesTrialInput, 'deadlineMs' | 'maxTokens'> = {
  prompt:
    'Look at invoices.csv in the working directory and report the total. Reply with a fenced JSON block.\n',
  fixtures: [
    {
      path: 'invoices.csv',
      content: 'invoice_no,vendor,amount\nINV-1,Acme,100.00\nINV-2,Beta,942.00\n',
    },
  ],
  toolsets: ['terminal', 'file'],
  maxTurns: 6,
  budgetSeconds: 180,
};

/** The trial's config.yaml: everything that is not a per-run flag, with nothing secret in it. */
export function trialConfig(options: {
  model: string;
  provider: string;
  maxTurns: number;
  budgetSeconds: number;
  toolsets: string[];
}) {
  return {
    model: {
      default: options.model,
      provider: options.provider,
      base_url: 'http://egress:8080/v1',
      context_length: 131072,
    },
    toolsets: options.toolsets,
    memory: { memory_enabled: false, user_profile_enabled: false },
    mcp_servers: {},
    agent: { max_turns: options.maxTurns, run_budget_seconds: options.budgetSeconds },
    approvals: { mode: 'off' },
    updates: { check: false },
    plugins: { auto_update_check_hours: 0 },
    curator: { enabled: false },
    auxiliary: { title_generation: { enabled: false } },
    security: { allow_lazy_installs: false, protected_instruction_files: false },
    gateway: { unmanaged_idle_exit_seconds: 5 },
  };
}

/** One Hermes run against the scripted mock model (or any model the deps name). */
export function runHermesSmoke(deps: SmokeDeps): Promise<SmokeReport> {
  return runHermesTrial(deps, {
    ...SMOKE_INPUT,
    deadlineMs: deps.deadlineMs ?? 300_000,
    maxTokens: 100_000,
  });
}

/** Runs Hermes once in a fresh trial container through the model gateway, and reports everything it observed. */
export async function runHermesTrial(
  deps: SmokeDeps,
  input: HermesTrialInput,
): Promise<SmokeReport> {
  const attemptId = newId();
  const runId = newId();
  const token = newAttemptToken();
  const dirs = await prepareTrialDirs(deps.trialsDir, attemptId);
  await mkdir(join(dirs.home, '.run'), { mode: 0o700 });
  await writeFile(join(dirs.home, '.no-bundled-skills'), '');
  await writeFile(join(dirs.home, 'task.txt'), input.prompt);
  await writeFile(
    join(dirs.home, 'config.yaml'),
    stringify(
      trialConfig({
        model: deps.model,
        provider: deps.hermesProvider,
        maxTurns: input.maxTurns,
        budgetSeconds: input.budgetSeconds,
        toolsets: input.toolsets,
      }),
    ),
  );
  for (const fixture of input.fixtures) {
    if (fixture.path.startsWith('/') || fixture.path.split('/').includes('..')) {
      throw new Error(`fixture path must be relative and inside the workspace: ${fixture.path}`);
    }
    const target = join(dirs.workspace, fixture.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, fixture.content);
  }

  await deps.egress.register(attemptId, {
    token,
    mode: 'allowlist',
    allowHosts: [],
    provider: deps.provider,
    models: [deps.model],
    maxTokens: input.maxTokens,
    expiresAt: Date.now() + input.deadlineMs + 60_000,
  });

  const events: Array<Record<string, unknown>> = [];
  const nonJsonLines: string[] = [];
  const stderr: Buffer[] = [];
  let outcome: TrialOutcome;
  let egressRecord: Awaited<ReturnType<EgressClient['remove']>> | undefined;
  try {
    outcome = await runTrial({
      engine: deps.engine,
      spec: {
        name: `hermes-evals-run-${runId}`,
        runId,
        attemptId,
        image: deps.image,
        volume: deps.volume,
        network: deps.slot,
        cmd: [
          'chat',
          '--query-file',
          `${TRIAL_HOME}/task.txt`,
          '--oneshot',
          '--format',
          'stream-json',
          '--provider',
          deps.hermesProvider,
          '-m',
          deps.model,
          '--base-url',
          'http://egress:8080/v1',
          '--api-key',
          token,
          '-t',
          input.toolsets.join(','),
          '--max-turns',
          String(input.maxTurns),
          '--yolo',
          '--in',
          TRIAL_WORKSPACE,
        ],
        env: {
          HOME: TRIAL_HOME,
          HERMES_HOME: TRIAL_HOME,
          HERMES_WRITE_SAFE_ROOT: `${TRIAL_WORKSPACE}:${TRIAL_HOME}`,
          XDG_RUNTIME_DIR: `${TRIAL_HOME}/.run`,
          TMPDIR: '/tmp',
          HTTPS_PROXY: `http://${attemptId}:${token}@egress:3128`,
          https_proxy: `http://${attemptId}:${token}@egress:3128`,
          HTTP_PROXY: `http://${attemptId}:${token}@egress:3128`,
          http_proxy: `http://${attemptId}:${token}@egress:3128`,
          NO_PROXY: 'egress',
          no_proxy: 'egress',
          NODE_USE_ENV_PROXY: '1',
        },
        deadline: Math.floor((Date.now() + input.deadlineMs) / 1000) + 60,
      },
      deadlineMs: input.deadlineMs,
      diskLimit: {
        ...DEFAULT_DISK_LIMIT,
        roots: [dirs.home, dirs.workspace],
      },
      onStdoutLine: (line) => {
        try {
          events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          nonJsonLines.push(line);
        }
      },
      onStderr: (chunk) => stderr.push(chunk),
    });
  } finally {
    // runTrial removed the container; the token dies with the registration, even on failure.
    egressRecord = await deps.egress.remove(attemptId);
  }
  // The agent could have replaced anything in its home: read it the untrusting way.
  const home = await walkTrialTree(dirs.home);
  const homeFiles = home.entries.map((e) => e.path);
  // Search every file Hermes left, not just config.yaml, for the attempt token.
  const tokenInHome: string[] = [];
  const tokenUnchecked: string[] = [];
  for (const entry of home.entries) {
    if (entry.kind !== 'file') continue;
    const read = await readTrialFile(dirs.home, entry.path);
    if (!read.ok) tokenUnchecked.push(`${entry.path} (${read.reason})`);
    else if (read.content.includes(token)) tokenInHome.push(entry.path);
  }

  return {
    attemptId,
    outcome,
    events,
    nonJsonLines,
    stderrTail: Buffer.concat(stderr).toString('utf8').slice(-4000),
    usage: egressRecord?.usage ?? null,
    egressLog: egressRecord?.log ?? [],
    homeFiles,
    tokenInHome,
    tokenUnchecked,
    finalText: (() => {
      const result = events.findLast((e) => e.type === 'result');
      return typeof result?.text === 'string' ? result.text : null;
    })(),
  };
}

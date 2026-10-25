/**
 * The scripted world the Phase 2 full-application e2e runs in: a worker
 * sandbox whose engine and egress are the in-process fakes (fake-engine.ts),
 * with isolation counted as proven, and a "Hermes" that answers the e2e's
 * three tasks the way each configuration's model asks it to.
 *
 * What a trial does is chosen by the configuration's model (`-m`):
 *
 * | model              | behaviour                                                     |
 * | ------------------ | ------------------------------------------------------------- |
 * | `mock/scripted`    | answers each task; without a skill it gets `numeric` wrong    |
 * | `mock/priced`      | the same, under a priced model id (the spend guard)           |
 * | `mock/hang`        | runs until it is stopped                                      |
 * | `mock/hang-once`   | the run's first container runs until stopped, later ones answer |
 * | `mock/fail-once`   | the run's first container dies before init (setup), later answer |
 * | `mock/broken`      | every container dies before init (setup)                      |
 *
 * hold(model) makes the next containers of that model wait at a gate until
 * release(model), so a test can act while runs are known to be running.
 * Tasks are told apart by their prompt (task.txt in the trial home), and the
 * answer key by whether the configuration has a skill (`-s`): the "skill"
 * is what makes the candidate right.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardConfig } from '@hermes-evals/docker-guard/policy';
import type { EgressLogEntry, EgressRegistration } from '../../src/sandbox/egress-client.js';
import type { SandboxService } from '../../src/sandbox/sandbox.service.js';
import type { SelfTestCheck } from '../../src/sandbox/self-test.js';
import {
  FakeEgress,
  FakeEngine,
  streamJson,
  type FakeContainerInfo,
  type FakeStep,
  type FakeTrialScript,
} from './fake-engine.js';

/** Tokens every answering trial reports in its `result`, and egress in its usage. */
export const TRIAL_TOKENS = { input: 3300, output: 63 } as const;

/** What `hermes tools list` prints in the trial image (the part presence reads). */
const TOOLS_LIST = [
  'Built-in toolsets (cli):',
  '  ✓ enabled  file  📁 File Operations',
  '  ✓ enabled  terminal  💻 Terminal',
  '  ✓ enabled  web  🔍 Web Search & Scraping',
  '  ✗ disabled  video  🎬 Video Analysis',
  '',
];

/** The answers of the e2e suite's tasks (test/fixtures/suites/complete). */
export const ANSWERS = {
  numericRight: '```json\n{"total": 10.5}\n```',
  numericWrong: '```json\n{"total": 10.0}\n```',
  ids: '```json\n{"ids": ["a", "b", "c"]}\n```',
  done: 'Wrote summary.csv.\n```json\n{"done": true}\n```',
  summaryCsv: 'vendor,total\nAcme,15\nGlobex,7\n',
} as const;

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

const gate = (): Gate => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

const argAfter = (argv: readonly string[], flag: string): string | null => {
  const at = argv.indexOf(flag);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};

/** One trial that answers its task, as Hermes 4d04303 prints it. */
function answering(info: FakeContainerInfo, model: string, before: FakeStep[]): FakeTrialScript {
  const prompt = readFileSync(join(info.homeDir!, 'task.txt'), 'utf8');
  const skilled = info.argv.includes('-s');
  const files: FakeStep[] = [];
  let answer: string;
  if (prompt.includes('amounts.csv')) {
    answer = skilled ? ANSWERS.numericRight : ANSWERS.numericWrong;
  } else if (prompt.includes('items.csv')) {
    answer = ANSWERS.ids;
  } else if (prompt.includes('summary.csv')) {
    files.push({ file: { in: 'workspace', path: 'summary.csv', content: ANSWERS.summaryCsv } });
    answer = ANSWERS.done;
  } else {
    answer = 'I do not know this task.';
  }
  // An agent that prints a stdio MCP value it can read: the runner must redact it.
  const echo = info.env['INVOICE_DB_URL']
    ? [{ stdout: streamJson.text(`Using the invoice database at ${info.env['INVOICE_DB_URL']}.`) }]
    : [];
  return {
    steps: [
      ...before,
      { stdout: streamJson.init(model) },
      { stdout: streamJson.toolUse('terminal', { command: 'ls' }) },
      { stdout: streamJson.toolResult('terminal', 'amounts.csv') },
      ...echo,
      ...files,
      { stdout: streamJson.text(answer) },
      { stdout: streamJson.result({ text: answer, tokens: TRIAL_TOKENS }) },
    ],
    exitCode: 0,
  };
}

/** Dies before init, as a broken Hermes start does: classified `setup`. */
const deadOnStart: FakeTrialScript = {
  steps: [{ stderr: 'Traceback (most recent call last):\nImportError: broken venv\n' }],
  exitCode: 1,
};

export class TrialScripts {
  /** Containers created per run id. */
  readonly perRun = new Map<string, number>();
  private readonly gates = new Map<string, Gate>();

  /** The next containers of `model` wait at a gate until release(model). */
  hold(model: string): void {
    if (!this.gates.has(model)) this.gates.set(model, gate());
  }

  release(model: string): void {
    this.gates.get(model)?.open();
    this.gates.delete(model);
  }

  readonly script = (info: FakeContainerInfo): FakeTrialScript => {
    if (info.argv.includes('tools') && info.argv.includes('list')) {
      return { steps: TOOLS_LIST.map((line) => ({ stdout: line })), exitCode: 0 };
    }
    if (!info.argv.includes('chat')) return { exitCode: 0 };
    const runId = info.labels['hermes-evals.run'] ?? info.name;
    const nth = (this.perRun.get(runId) ?? 0) + 1;
    this.perRun.set(runId, nth);
    const model = argAfter(info.argv, '-m') ?? 'mock/scripted';
    const held = this.gates.get(model);
    const before: FakeStep[] = held ? [{ wait: held.promise }] : [];
    switch (model) {
      case 'mock/hang':
        return { steps: [{ stdout: streamJson.init(model) }], hang: true };
      case 'mock/hang-once':
        return nth === 1
          ? { steps: [{ stdout: streamJson.init(model) }], hang: true }
          : answering(info, model, before);
      case 'mock/fail-once':
        return nth === 1 ? deadOnStart : answering(info, model, before);
      case 'mock/broken':
        return deadOnStart;
      default:
        return answering(info, model, before);
    }
  };
}

/** Egress's report for an attempt: one model call with its own usage. */
export function egressReport(
  _attemptId: string,
  registration: EgressRegistration,
): {
  usage: { calls: number; promptTokens: number; completionTokens: number };
  log: EgressLogEntry[];
} {
  return {
    usage: { calls: 1, promptTokens: TRIAL_TOKENS.input, completionTokens: TRIAL_TOKENS.output },
    log: [
      {
        at: new Date().toISOString(),
        kind: 'model',
        model: registration.models?.[0] ?? 'mock/scripted',
        decision: 'allowed',
        status: 200,
        ms: 25,
        promptTokens: TRIAL_TOKENS.input,
        completionTokens: TRIAL_TOKENS.output,
      },
    ],
  };
}

/** The checks a proven sandbox reports (names from sandbox/self-test.ts). */
const PROVEN: SelfTestCheck[] = [
  { name: 'probe ran', ok: true, detail: 'fake engine' },
  { name: 'runs as uid 10000', ok: true, detail: 'uid 10000' },
  { name: 'has no default route', ok: true, detail: 'no default route' },
  { name: 'reaches nothing but egress', ok: true, detail: 'fake egress only' },
];

export interface FakeSandboxParts {
  engine: FakeEngine;
  egress: FakeEgress;
  trialsDir: string;
  image: string;
  volume: string;
  slots: string[];
}

/** A self-test whose network check failed, as a misconfigured slot network reports it. */
const FAILED: SelfTestCheck[] = [
  ...PROVEN.slice(0, 2),
  { name: 'has no default route', ok: false, detail: 'default via 172.20.0.1 dev eth0' },
];

/**
 * Stands in for SandboxService in WorkerModule: the fakes for the engine
 * and egress, and the self-test counted as passed, or as failed when
 * `isolated` is false (the engine still answers, so the worker knows its
 * daemon and runs recovery, but must take no execute-run job).
 */
export function fakeSandbox(
  parts: FakeSandboxParts,
  { isolated = true }: { isolated?: boolean } = {},
): SandboxService {
  return {
    ...parts,
    verify: () => Promise.resolve(isolated),
    status: () =>
      isolated ? { state: 'isolated', checks: PROVEN } : { state: 'failed', checks: FAILED },
  } as unknown as SandboxService;
}

/** The engine and egress one fake Docker daemon gives every worker on it. */
export function fakeDaemon(options: {
  trialsDir: string;
  guard: GuardConfig;
  scripts: TrialScripts;
  egressEnvNames?: string[];
}): { engine: FakeEngine; egress: FakeEgress } {
  return {
    engine: new FakeEngine({
      trialsDir: options.trialsDir,
      guard: options.guard,
      script: options.scripts.script,
      daemonId: 'E2E:DAEMON',
    }),
    egress: new FakeEgress({ report: egressReport, envNames: options.egressEnvNames ?? [] }),
  };
}

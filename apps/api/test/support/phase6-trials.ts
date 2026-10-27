/**
 * The scripted world of the Phase 6 full-application e2e: its suite (test/
 * fixtures/phase6-suite, one task with home seeds) and the "Hermes" the fake
 * engine plays. No model is ever called.
 *
 * Each trial records what its container was given before it ran: the home
 * seeds under memories/, the memory setting in config.yaml, the skills
 * installed under skills/, and its argv (`-t`, `-s`). Then it answers the
 * task. With memory on it saves the preference the prompt states, as
 * Hermes's memory tool would: one more entry in memories/MEMORY.md after the
 * seed, behind the entry delimiter. With memory off the tool does not exist
 * and the home holds no seed (Phase 8 G9).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_ENTRY_DELIMITER } from '@hermes-evals/shared';
import {
  streamJson,
  type FakeContainerInfo,
  type FakeStep,
  type FakeTrialScript,
} from './fake-engine.js';
import { TRIAL_TOKENS, TrialScripts } from './fake-trials.js';

export const PHASE6_SUITE = {
  name: 'phase6',
  dir: join(import.meta.dirname, '..', 'fixtures', 'phase6-suite'),
  tasks: ['remember'],
} as const;

const TASK_DIR = join(PHASE6_SUITE.dir, 'remember');
/** The seeds as the task folder holds them, by home-relative path. */
export const SEEDS = {
  'memories/MEMORY.md': readFileSync(join(TASK_DIR, 'home', 'memories', 'MEMORY.md'), 'utf8'),
  'memories/USER.md': readFileSync(join(TASK_DIR, 'home', 'memories', 'USER.md'), 'utf8'),
} as const;

/** The entry the agent saves with memory on. */
export const SAVED_ENTRY = 'The user wants vendor totals sorted largest first.';
/** MEMORY.md after a run with memory on: the seed, then the saved entry. */
export const SAVED_MEMORY = `${SEEDS['memories/MEMORY.md'].trimEnd()}${MEMORY_ENTRY_DELIMITER}${SAVED_ENTRY}\n`;

/** What a trial container held when it started. */
export interface TrialSeen {
  runId: string;
  argv: string[];
  memoryEnabled: boolean;
  /** memories/<name> → its text, for each file present. */
  memories: Record<string, string>;
  /** Directory names under skills/. */
  skills: string[];
}

const argAfter = (argv: readonly string[], flag: string): string | null => {
  const at = argv.indexOf(flag);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};

/** The `-t` list of an argv, or [] when there is none. */
export const toolsetsOf = (argv: readonly string[]): string[] =>
  argAfter(argv, '-t')?.split(',') ?? [];

/** Every `-s <name>` of an argv. */
export const preloadedOf = (argv: readonly string[]): string[] =>
  argv.flatMap((arg, i) => (arg === '-s' ? [argv[i + 1] ?? ''] : []));

function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** What the materialised home holds when the container is created. */
function seen(info: FakeContainerInfo): TrialSeen {
  const home = info.homeDir!;
  const config = readFileSync(join(home, 'config.yaml'), 'utf8');
  const memories: Record<string, string> = {};
  for (const name of filesIn(join(home, 'memories'))) {
    memories[`memories/${name}`] = readFileSync(join(home, 'memories', name), 'utf8');
  }
  return {
    runId: info.labels['hermes-evals.run'] ?? info.name,
    argv: info.argv,
    memoryEnabled: /^\s*memory_enabled: true$/m.test(config),
    memories,
    skills: filesIn(join(home, 'skills')),
  };
}

export class Phase6Trials {
  /** One entry per chat container, in creation order. */
  readonly seen: TrialSeen[] = [];
  private readonly fallback = new TrialScripts();

  /** The record of the run's (last) container. */
  of(runId: string): TrialSeen | undefined {
    return this.seen.findLast((s) => s.runId === runId);
  }

  readonly script = (info: FakeContainerInfo): FakeTrialScript => {
    if (!info.argv.includes('chat') || !info.homeDir) return this.fallback.script(info);
    // The home is read while the create call is answered, before the start.
    const record = seen(info);
    this.seen.push(record);
    const answer = 'There are 2 vendors.\n```json\n{"vendors": 2}\n```';
    const save: FakeStep[] = record.memoryEnabled
      ? [
          {
            stdout: streamJson.toolUse(
              'memory',
              { action: 'add', target: 'memory', content: SAVED_ENTRY },
              'call_1',
            ),
          },
          { file: { in: 'home', path: 'memories/MEMORY.md', content: SAVED_MEMORY } },
          { stdout: streamJson.toolResult('memory', 'Saved to memory.', 'call_1') },
        ]
      : [];
    return {
      steps: [
        { stdout: streamJson.init(argAfter(info.argv, '-m') ?? 'mock/scripted') },
        { stdout: streamJson.toolUse('read_file', { path: 'vendors.csv' }, 'call_0') },
        { stdout: streamJson.toolResult('read_file', 'vendor\nAcme\nGlobex\n', 'call_0') },
        ...save,
        { stdout: streamJson.text(answer) },
        { stdout: streamJson.result({ text: answer, tokens: TRIAL_TOKENS }) },
      ],
      exitCode: 0,
    };
  };
}

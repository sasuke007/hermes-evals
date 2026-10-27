/**
 * The scripted world of the Phase 8 full-application e2e: the repository's
 * invoices-v1 suite, and a "Hermes" the fake engine plays that answers each
 * of its tasks with the task's reference. No model is ever called.
 *
 * The two arms answer alike but write the answer differently: a trial with a
 * preloaded skill (`-s`, the with-skill arm) ends with a ```json block, a
 * trial without one replies with the bare JSON object and nothing else, as
 * the real model did when it left the fence out (Phase 8 G5). So every run
 * of the baseline is graded only if an unfenced answer is.
 *
 * The judge behind egress's judge path passes every reply.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from '@hermes-evals/shared';
import {
  streamJson,
  type FakeContainerInfo,
  type FakeJudgeAnswer,
  type FakeStep,
  type FakeTrialScript,
} from './fake-engine.js';
import { TRIAL_TOKENS, TrialScripts } from './fake-trials.js';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const SUITE_DIR = join(REPO, 'suites', 'invoices-v1');

/** The repository's invoices-v1, launched on every task. */
export const INVOICES_SUITE = {
  name: 'invoices-v1',
  dir: SUITE_DIR,
  tasks: readdirSync(SUITE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(),
} as const;

interface TaskAnswer {
  key: string;
  prompt: string;
  reference: JsonValue;
}

const TASKS: TaskAnswer[] = INVOICES_SUITE.tasks.map((key) => ({
  key,
  prompt: readFileSync(join(SUITE_DIR, key, 'prompt.md'), 'utf8').trim(),
  reference: JSON.parse(readFileSync(join(SUITE_DIR, key, 'reference.json'), 'utf8')) as JsonValue,
}));

/** summary_file's expected workspace file, which its file_check and verifier read. */
const SUMMARY_CSV = readFileSync(
  join(SUITE_DIR, 'summary_file', 'expected', 'summary.csv'),
  'utf8',
);

/** The reply without a fence: only the object, with blank lines around it. */
export const unfencedReply = (reference: JsonValue): string =>
  `\n${JSON.stringify(reference, null, 2)}\n`;

/** The reply with a fence. */
export const fencedReply = (reference: JsonValue): string =>
  `Here is the answer.\n\n\`\`\`json\n${JSON.stringify(reference)}\n\`\`\`\n`;

/** The task's reference, by key. */
export const referenceOf = (key: string): JsonValue => TASKS.find((t) => t.key === key)!.reference;

const argAfter = (argv: readonly string[], flag: string): string | null => {
  const at = argv.indexOf(flag);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};

export class Phase8Trials {
  /** Chat containers answered, by task key. */
  readonly answered = new Map<string, number>();
  private readonly fallback = new TrialScripts();

  readonly script = (info: FakeContainerInfo): FakeTrialScript => {
    if (!info.argv.includes('chat') || !info.homeDir) return this.fallback.script(info);
    const prompt = readFileSync(join(info.homeDir, 'task.txt'), 'utf8').trim();
    const task = TASKS.find((t) => t.prompt === prompt);
    if (!task) return this.fallback.script(info);
    this.answered.set(task.key, (this.answered.get(task.key) ?? 0) + 1);
    const answer = info.argv.includes('-s')
      ? fencedReply(task.reference)
      : unfencedReply(task.reference);
    const files: FakeStep[] =
      task.key === 'summary_file'
        ? [{ file: { in: 'workspace', path: 'summary.csv', content: SUMMARY_CSV } }]
        : [];
    return {
      steps: [
        { stdout: streamJson.init(argAfter(info.argv, '-m') ?? 'mock/scripted') },
        { stdout: streamJson.toolUse('terminal', { command: 'cat invoices.csv' }, 'call_0') },
        { stdout: streamJson.toolResult('terminal', 'invoice_id,vendor,amount', 'call_0') },
        ...files,
        { stdout: streamJson.text(answer) },
        { stdout: streamJson.result({ text: answer, tokens: TRIAL_TOKENS }) },
      ],
      exitCode: 0,
    };
  };

  /** The judge passes every reply. */
  readonly judge = (): FakeJudgeAnswer => ({
    content: JSON.stringify({ score: 0.9, comment: 'Says how the figure was found.' }),
    promptTokens: 600,
    completionTokens: 20,
  });
}

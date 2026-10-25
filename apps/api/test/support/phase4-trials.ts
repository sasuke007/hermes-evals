/**
 * The scripted world of the Phase 4 full-application e2e: its suite (test/
 * fixtures/phase4-suite, four questions on one CSV), the trials the fake
 * engine plays for each model, and the judge behind the fake egress judge
 * path. No model is ever called.
 *
 * Every task declares `answer` (numeric_tolerance on `value`) and `cites`
 * (text_match on `note`); sum_amounts also has `quality`, an llm_judge key,
 * and it is that task's primary key. The others grade by `answer`.
 *
 * What a trial answers is chosen by the configuration's model (`-m`):
 *
 * | task        | `mock/good`           | `mock/weak`                        |
 * | ----------- | --------------------- | ---------------------------------- |
 * | sum_amounts | 10.5, cites           | 10.5, no cite                      |
 * | count_rows  | 2, cites              | 3 (wrong), cites                   |
 * | max_amount  | 6.25, cites           | 4.25 (wrong), cites                |
 * | min_amount  | 4.25, cites           | 6.25 (wrong), no cite              |
 *
 * So `good` passes every task under every key, and `weak` passes only
 * sum_amounts under the primary keys. The first container of count_rows and
 * of min_amount under `weak` dies before init (an execution error of
 * category setup, never retried automatically); later ones answer.
 *
 * The judge gives 0.9 (passed) to every reply, or 0.3 (failed) to the next
 * one after failNext(). On the trials and the judge, hold() keeps what
 * starts next waiting until release(), so a test can act while a run or an
 * evaluation is known to be in flight. Trials that die wait at their own
 * gate, `die`, and answering ones at `answer`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  streamJson,
  type FakeContainerInfo,
  type FakeJudgeAnswer,
  type FakeStep,
  type FakeTrialScript,
} from './fake-engine.js';
import { TRIAL_TOKENS, TrialScripts } from './fake-trials.js';

export const PHASE4_SUITE = {
  name: 'phase4',
  dir: join(import.meta.dirname, '..', 'fixtures', 'phase4-suite'),
  tasks: ['sum_amounts', 'count_rows', 'max_amount', 'min_amount'],
} as const;

export type Phase4Task = (typeof PHASE4_SUITE.tasks)[number];
export type Phase4Model = 'mock/good' | 'mock/weak';

/** The model sum_amounts' `quality` check names. */
export const JUDGE_MODEL = 'mock/judge';

/**
 * USD per 1M tokens. Every attempt is metered at TRIAL_TOKENS (3,300 in,
 * 63 out), so an attempt of `good` costs $0.0066 and one of `weak` $0.0033;
 * the judge is free.
 */
export const PHASE4_PRICES = `models:
  mock/good:
    input_per_1m: 2
    output_per_1m: 0
    checked_at: '2026-10-25'
  mock/weak:
    input_per_1m: 1
    output_per_1m: 0
    checked_at: '2026-10-25'
  mock/judge:
    input_per_1m: 0
    output_per_1m: 0
    checked_at: '2026-10-25'
`;

export const ATTEMPT_COST_USD: Record<Phase4Model, number> = {
  'mock/good': 0.0066,
  'mock/weak': 0.0033,
};

const CITE = 'source: amounts.csv';
const NO_CITE = 'from the file';

/** What each model answers: the value and the note. */
const ANSWERS: Record<Phase4Task, Record<Phase4Model, { value: number; note: string }>> = {
  sum_amounts: {
    'mock/good': { value: 10.5, note: CITE },
    'mock/weak': { value: 10.5, note: NO_CITE },
  },
  count_rows: {
    'mock/good': { value: 2, note: CITE },
    'mock/weak': { value: 3, note: CITE },
  },
  max_amount: {
    'mock/good': { value: 6.25, note: CITE },
    'mock/weak': { value: 4.25, note: CITE },
  },
  min_amount: {
    'mock/good': { value: 4.25, note: CITE },
    'mock/weak': { value: 6.25, note: NO_CITE },
  },
};

/** The tasks whose first `weak` container dies before init. */
export const DYING_TASKS: readonly Phase4Task[] = ['count_rows', 'min_amount'];

/** Which task a trial's prompt (task.txt) is. */
function taskOf(prompt: string): Phase4Task | null {
  if (prompt.includes('Add up')) return 'sum_amounts';
  if (prompt.includes('Count the data rows')) return 'count_rows';
  if (prompt.includes('largest')) return 'max_amount';
  if (prompt.includes('smallest')) return 'min_amount';
  return null;
}

const argAfter = (argv: readonly string[], flag: string): string | null => {
  const at = argv.indexOf(flag);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

const gate = (): Gate => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

type GateName = 'answer' | 'die';

export class Phase4Trials {
  /** Run ids of the containers that died (or will die once `die` opens), in creation order. */
  readonly dying: string[] = [];
  /** The Phase 2 scripts answer everything that is not a chat (`hermes tools list`). */
  private readonly fallback = new TrialScripts();
  private readonly gates = new Map<GateName, Gate>();
  private readonly started = new Map<string, number>();

  /** The next trials of that kind wait after start until release(name). */
  hold(name: GateName): void {
    if (!this.gates.has(name)) this.gates.set(name, gate());
  }

  release(name: GateName): void {
    this.gates.get(name)?.open();
    this.gates.delete(name);
  }

  releaseAll(): void {
    // Deleting the entry being visited is safe while iterating a Map.
    for (const name of this.gates.keys()) this.release(name);
  }

  private wait(name: GateName): FakeStep[] {
    const held = this.gates.get(name);
    return held ? [{ wait: held.promise }] : [];
  }

  readonly script = (info: FakeContainerInfo): FakeTrialScript => {
    if (!info.argv.includes('chat') || !info.homeDir) return this.fallback.script(info);
    const model: Phase4Model =
      argAfter(info.argv, '-m') === 'mock/weak' ? 'mock/weak' : 'mock/good';
    const task = taskOf(readFileSync(join(info.homeDir, 'task.txt'), 'utf8'));
    const nth = (this.started.get(`${task}/${model}`) ?? 0) + 1;
    this.started.set(`${task}/${model}`, nth);
    if (task && model === 'mock/weak' && DYING_TASKS.includes(task) && nth === 1) {
      this.dying.push(info.labels['hermes-evals.run'] ?? info.name);
      return {
        steps: [
          ...this.wait('die'),
          { stderr: 'Traceback (most recent call last):\nImportError: broken venv\n' },
        ],
        exitCode: 1,
      };
    }
    const answer = task
      ? `Done.\n\`\`\`json\n${JSON.stringify(ANSWERS[task][model])}\n\`\`\``
      : 'I do not know this task.';
    return {
      steps: [
        ...this.wait('answer'),
        { stdout: streamJson.init(model) },
        { stdout: streamJson.toolUse('read_file', { path: 'amounts.csv' }, 'call_0') },
        { stdout: streamJson.toolResult('read_file', 'id,amount\n1,4.25\n2,6.25\n', 'call_0') },
        { stdout: streamJson.text(answer) },
        { stdout: streamJson.result({ text: answer, tokens: TRIAL_TOKENS }) },
      ],
      exitCode: 0,
    };
  };
}

/** The judge's verdicts. */
export const VERDICTS = {
  pass: { score: 0.9, comment: 'Gives the total and says how it was found.' },
  fail: { score: 0.3, comment: 'Gives a total but not how it was found.' },
} as const;

/** The model behind egress's judge path. */
export class Phase4Judge {
  /** How many calls the judge has answered or is answering. */
  calls = 0;
  private failing = 0;
  private held: Gate | null = null;

  /** The next call fails (0.3); later ones pass again. */
  failNext(): void {
    this.failing += 1;
  }

  /** Judge calls wait from now until release(). */
  hold(): void {
    this.held ??= gate();
  }

  release(): void {
    this.held?.open();
    this.held = null;
  }

  readonly model = async (): Promise<FakeJudgeAnswer> => {
    this.calls += 1;
    const verdict = this.failing > 0 ? VERDICTS.fail : VERDICTS.pass;
    if (this.failing > 0) this.failing -= 1;
    await this.held?.promise;
    return { content: JSON.stringify(verdict), promptTokens: 600, completionTokens: 20 };
  };
}

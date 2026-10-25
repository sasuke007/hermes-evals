/**
 * The scripted world of the Phase 3 full-application e2e: its suite (test/
 * fixtures/phase3-suite, whose four tasks between them use all eight check
 * types), the trials the fake engine plays for its two configurations, and
 * the model behind the fake egress judge path. No model is ever called.
 *
 * What a trial does is chosen by the configuration's model (`-m`):
 *
 * | task            | `mock/right`                                    | `mock/wrong`                                        |
 * | --------------- | ----------------------------------------------- | --------------------------------------------------- |
 * | invoice_total   | reads amounts.csv, total 10.5, says how         | runs `cat` in the terminal, total 10.0              |
 * | ledger          | ids in another order, currency in lower case    | no fenced JSON block at all                         |
 * | late_fee_rule   | the rule with "1.5%" and "30 days"              | the rule with "45 days": one phrase missing         |
 * | summary_file    | summary.csv right                               | summary.csv with one vendor's total wrong           |
 *
 * The judge grades what the agent wrote, as a model following the rubric
 * would: under invoice_total's rubric 0.9 for a reply that gives the right
 * total, 0.3 otherwise; under late_fee_rule's tone rubric 0.8 for any rule
 * stated in one sentence, as both trials state it. On both
 * the trials and the judge, hold() keeps what starts next waiting until
 * release(), so a test can act while a run or an evaluation is known to be
 * running.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EgressJudgeChatBody } from '../../src/sandbox/egress-client.js';
import {
  streamJson,
  type FakeContainerInfo,
  type FakeJudgeAnswer,
  type FakeStep,
  type FakeTrialScript,
} from './fake-engine.js';
import { TRIAL_TOKENS, TrialScripts } from './fake-trials.js';

export const PHASE3_SUITE = {
  name: 'phase3',
  dir: join(import.meta.dirname, '..', 'fixtures', 'phase3-suite'),
  tasks: ['invoice_total', 'ledger', 'late_fee_rule', 'summary_file'],
} as const;

export type Phase3Task = (typeof PHASE3_SUITE.tasks)[number];
export type Phase3Config = 'right' | 'wrong';

/** The judge model the invoice_total task's `method` check names. */
export const JUDGE_MODEL = 'mock/judge';

/** What the fake judge model reports for each call. */
export const JUDGE_TOKENS = { prompt: 900, completion: 30 } as const;

/**
 * USD per 1M tokens. The trials are free; the judge is priced, so its
 * cost is visible: 900 × 2 / 1e6 + 30 × 10 / 1e6 = $0.0021 a call.
 */
export const PHASE3_PRICES = `models:
  mock/right:
    input_per_1m: 0
    output_per_1m: 0
    checked_at: '2026-10-25'
  mock/wrong:
    input_per_1m: 0
    output_per_1m: 0
    checked_at: '2026-10-25'
  mock/judge:
    input_per_1m: 2
    output_per_1m: 10
    checked_at: '2026-10-25'
`;

export const JUDGE_CALL_COST_USD = 0.0021;

const fence = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** The final text of each task, as each configuration answers it. */
export const PHASE3_ANSWERS: Record<Phase3Task, Record<Phase3Config, string>> = {
  invoice_total: {
    right: `I added the amount column of amounts.csv: 4.25 + 6.25 = 10.5.\n${fence({ total: 10.5 })}`,
    wrong: `The total looks like 10.\n${fence({ total: 10.0 })}`,
  },
  ledger: {
    right: `Open: c, a and b; the ledger is in euros.\n${fence({ ids: ['c', 'a', 'b'], currency: 'eur' })}`,
    wrong: 'The open ids are a, b and c, and the ledger is in euros.',
  },
  late_fee_rule: {
    right: fence({ rule: 'A late fee of 1.5% applies to invoices unpaid after 30 days.' }),
    wrong: fence({ rule: 'A late fee of 1.5% applies to invoices unpaid after 45 days.' }),
  },
  summary_file: {
    right: `Wrote summary.csv.\n${fence({ done: true })}`,
    wrong: `Wrote summary.csv.\n${fence({ done: true })}`,
  },
};

export const SUMMARY_CSV: Record<Phase3Config, string> = {
  right: 'vendor,total\nAcme,15\nGlobex,7\n',
  wrong: 'vendor,total\nAcme,15\nGlobex,9\n',
};

/** Which task a trial's prompt (task.txt) is. */
function taskOf(prompt: string): Phase3Task | null {
  if (prompt.includes('amounts.csv')) return 'invoice_total';
  if (prompt.includes('items.csv')) return 'ledger';
  if (prompt.includes('terms.md')) return 'late_fee_rule';
  if (prompt.includes('summary.csv')) return 'summary_file';
  return null;
}

const argAfter = (argv: readonly string[], flag: string): string | null => {
  const at = argv.indexOf(flag);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
};

/** The tool calls a trial makes before it answers. */
function toolSteps(task: Phase3Task, config: Phase3Config): FakeStep[] {
  if (task === 'invoice_total' && config === 'right') {
    return [
      { stdout: streamJson.toolUse('read_file', { path: 'amounts.csv' }, 'call_0') },
      { stdout: streamJson.toolResult('read_file', 'id,amount\n1,4.25\n2,6.25\n', 'call_0') },
    ];
  }
  if (task === 'invoice_total') {
    return [
      { stdout: streamJson.toolUse('terminal', { command: 'cat amounts.csv' }, 'call_0') },
      { stdout: streamJson.toolResult('terminal', 'id,amount\n1,4.25\n2,6.25', 'call_0') },
    ];
  }
  return [
    { stdout: streamJson.toolUse('terminal', { command: 'ls' }, 'call_0') },
    { stdout: streamJson.toolResult('terminal', 'fixtures', 'call_0') },
  ];
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

const gate = (): Gate => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

export class Phase3Trials {
  /** Every trial's config.yaml as the runner wrote it, in creation order. */
  readonly configYamls: string[] = [];
  /** The Phase 2 scripts answer everything that is not a chat (`hermes tools list`). */
  private readonly fallback = new TrialScripts();
  private held: Gate | null = null;

  /** The next trials wait after start until release(). */
  hold(): void {
    this.held ??= gate();
  }

  release(): void {
    this.held?.open();
    this.held = null;
  }

  readonly script = (info: FakeContainerInfo): FakeTrialScript => {
    if (!info.argv.includes('chat') || !info.homeDir) return this.fallback.script(info);
    this.configYamls.push(readFileSync(join(info.homeDir, 'config.yaml'), 'utf8'));
    const model = argAfter(info.argv, '-m') ?? 'mock/right';
    const config: Phase3Config = model === 'mock/wrong' ? 'wrong' : 'right';
    const task = taskOf(readFileSync(join(info.homeDir, 'task.txt'), 'utf8'));
    const answer = task ? PHASE3_ANSWERS[task][config] : 'I do not know this task.';
    const files: FakeStep[] =
      task === 'summary_file'
        ? [{ file: { in: 'workspace', path: 'summary.csv', content: SUMMARY_CSV[config] } }]
        : [];
    return {
      steps: [
        ...(this.held ? [{ wait: this.held.promise }] : []),
        { stdout: streamJson.init(model) },
        ...(task ? toolSteps(task, config) : []),
        ...files,
        { stdout: streamJson.text(answer) },
        { stdout: streamJson.result({ text: answer, tokens: TRIAL_TOKENS }) },
      ],
      exitCode: 0,
    };
  };
}

/** The verdicts the judge gives. */
export const VERDICTS = {
  right: { score: 0.9, comment: 'Gives the right total and says it added the amount column.' },
  wrong: { score: 0.3, comment: 'The total is wrong.' },
} as const;

/** The verdict under late_fee_rule's tone rubric, which asks for a plain one-sentence rule. */
export const TONE_VERDICT = {
  score: 0.8,
  comment: 'States the rule plainly, in one sentence.',
} as const;

/** What marks late_fee_rule's rubric in the judge's system message. */
const TONE_RUBRIC = 'Full marks when the rule is stated plainly';

/** The model behind egress's judge path: grades the agent's text in the user message. */
export class ScriptedJudge {
  /** Every body the judge was asked, in order. */
  readonly asked: EgressJudgeChatBody[] = [];
  private held: Gate | null = null;

  /** Judge calls wait from now until release(). */
  hold(): void {
    this.held ??= gate();
  }

  release(): void {
    this.held?.open();
    this.held = null;
  }

  readonly model = async (body: EgressJudgeChatBody): Promise<FakeJudgeAnswer> => {
    this.asked.push(body);
    await this.held?.promise;
    const rules = body.messages.find((m) => m.role === 'system')?.content ?? '';
    const response = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const verdict = rules.includes(TONE_RUBRIC)
      ? TONE_VERDICT
      : response.includes('10.5')
        ? VERDICTS.right
        : VERDICTS.wrong;
    return {
      content: JSON.stringify(verdict),
      promptTokens: JUDGE_TOKENS.prompt,
      completionTokens: JUDGE_TOKENS.completion,
    };
  };
}

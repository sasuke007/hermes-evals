/**
 * Run inspector fixtures (GET /runs/:id): the drawer's five sections for any
 * run of the experiment fixtures. The board's sample run (dup_invoices ·
 * baseline · rep 3 of Skill vs no skill, run_01JB7X4K2M) is reproduced
 * verbatim, as are the runs of the Run inspector states board; every other
 * run gets a plausible detail built from its matrix cell.
 *
 * Runs that show a designed state without any scenario:
 *   execution-error  disputed · baseline · rep 4 of Skill vs no skill (timeout, 2 attempts)
 *   ungradable       credit_notes · baseline · rep 2 of Skill vs no skill
 *   score-error      credit_notes · with-skill · rep 4 of Skill vs no skill (method → 503)
 *   refused-by-sandbox currency_mix · with-skill · rep 2 of Skill vs no skill
 *   running          currency_mix · with-mcp · rep 5 of MCP vs baseline
 * Scenarios that change a run (see scenarios.ts): cancelled, multi-attempt,
 * disk-limit, token-cap, timeout-silent, provider-lapsed, verdict-updated,
 * no-worker; memory-files (per_vendor's memory files and home seeds, from
 * home.ts) and skills-on-demand (with-skill's launch without -s).
 */
import type { JsonValue } from '@hermes-evals/shared';
import type {
  ArtifactsView,
  ArtifactView,
  AttemptView,
  CounterpartView,
  ExecutionErrorView,
  FinalResponseView,
  LaunchRecordView,
  OutcomeNotice,
  RunDetail,
  RunEvaluationView,
  RunEventsPage,
  ScoreRowView,
  TimelineEvent,
} from '@/api/types/runs';
import type { TablePreview } from '@/api/types/suites';
import { configVersionIn, MODEL } from './configurations';
import { runComment, SAMPLE_RUN_COMMENT } from './comparison';
import {
  configRef,
  experimentSeeds,
  type ExperimentSeed,
  keyResults,
  primaryKey,
  type RunSeed,
  runKey,
  runsOf,
} from './experiments';
import { homeArtifactsFor, homeArtifactText, homeSeedsFor } from './home';
import { MCP_INVOICE_DB, SKILL_INVOICE_METHOD } from './resources';
import { runNeeds } from './runs';
import {
  addSeconds,
  at,
  INVOICES_PREVIEW,
  sha,
  SUITE_V1_REF,
  taskSeed,
  taskVerification,
  ulid,
} from './suites';

type Active = (name: string) => boolean;

/** Finds a run by id across the experiments of the active scenario. */
export function findRun(
  active: Active,
  runId: string,
): { seed: ExperimentSeed; run: RunSeed } | null {
  for (const seed of experimentSeeds(active)) {
    const run = runsOf(seed).find((r) => r.id === runId);
    if (run) return { seed, run };
  }
  return null;
}

/** The run id of a task, configuration and repetition in an experiment, for links and tests. */
export function runIdOf(
  active: Active,
  experimentId: string,
  task: string,
  config: string,
  rep: number,
): string | null {
  const seed = experimentSeeds(active).find((s) => s.id === experimentId);
  const run = seed
    ? runsOf(seed).find((r) => r.taskKey === task && r.config === config && r.repetition === rep)
    : undefined;
  return run?.id ?? null;
}

const is = (
  seed: ExperimentSeed,
  run: RunSeed,
  exp: ExperimentSeed['key'],
  task: string,
  config: string,
  rep: number,
) => seed.key === exp && run.taskKey === task && run.config === config && run.repetition === rep;

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function event(
  seq: number,
  partial: Partial<TimelineEvent> & Pick<TimelineEvent, 'kind' | 'atMs' | 'title' | 'summary'>,
): TimelineEvent {
  return {
    seq,
    origin: 'agent',
    server: null,
    durationMs: null,
    error: false,
    running: false,
    input: null,
    output: null,
    outputChars: null,
    truncated: false,
    text: null,
    network: null,
    refusal: null,
    ...partial,
  };
}

const HEAD_OUTPUT = `invoice_no,vendor_name,invoice_date,due_date,amount,currency,po_number,status
INV-0981,Brightline Freight,2026-08-02,2026-09-01,1625.00,EUR,PO-5518,open
INV-0988,Kestrel Office Supply,2026-08-04,2026-09-03,312.40,EUR,PO-5530,open
INV-0994,Norvale Logistics,2026-08-05,2026-09-04,2275.00,EUR,PO-5534,open
INV-1003,Brightline Freight,2026-08-09,2026-09-08,960.00,EUR,PO-5540,paid
INV-1011,Halden Print Co.,2026-08-11,2026-09-10,148.90,EUR,,open
INV-1017,Kestrel Office Supply,2026-08-12,2026-09-11,87.25,EUR,PO-5547,open
INV-1024,Norvale Logistics,2026-08-14,2026-09-13,1190.00,EUR,PO-5551,disputed
INV-1031,Halden Print Co.,2026-08-15,2026-08-30,410.00,EUR,PO-5553,open
INV-1042,Brightline Freight,2026-08-18,2026-09-17,1840.00,EUR,PO-5521,open`;

const MODEL_CALL_TEXT =
  'POST http://egress:8080/v1/chat/completions → 200, forwarded to Nous Portal.';

function modelCall(
  seq: number,
  atMs: number,
  durationMs: number,
  tokensIn: number,
  tokensOut: number,
  extra = '',
): TimelineEvent {
  return event(seq, {
    kind: 'network',
    atMs,
    title: 'Model call',
    summary: `${MODEL} · 200 · ${(tokensIn + tokensOut).toLocaleString('en-US')} tokens (${tokensIn.toLocaleString('en-US')} in / ${tokensOut.toLocaleString('en-US')} out)`,
    durationMs,
    text: extra ? `${MODEL_CALL_TEXT} ${extra}` : MODEL_CALL_TEXT,
    network: {
      kind: 'model',
      decision: 'allowed',
      method: 'POST',
      url: 'http://egress:8080/v1/chat/completions',
      host: null,
      port: null,
      server: null,
      status: 200,
      reason: null,
      model: MODEL,
      tokensIn,
      tokensOut,
      forwardedTo: 'Nous Portal',
    },
  });
}

function backgroundRefusal(seq: number): TimelineEvent {
  return event(seq, {
    kind: 'refused',
    origin: 'hermes-background',
    atMs: 600,
    title: 'Refused by sandbox',
    summary: 'inference-api.nousresearch.com:443',
    text: "Refused by sandbox: inference-api.nousresearch.com:443. Hermes looks up model prices in the background; this is not the agent's action and does not affect results.",
    network: {
      kind: 'connect',
      decision: 'denied',
      method: null,
      url: null,
      host: 'inference-api.nousresearch.com',
      port: 443,
      server: null,
      status: null,
      reason: 'not on the allowlist',
      model: null,
      tokensIn: null,
      tokensOut: null,
      forwardedTo: null,
    },
    refusal: { host: 'inference-api.nousresearch.com', port: 443, reason: 'not on the allowlist' },
  });
}

/** The sample run's timeline, verbatim from the Run inspector board. */
function sampleTimeline(): TimelineEvent[] {
  const py1 = `{"command": "python3 -c \\"import csv; from collections import Counter; rows = list(csv.DictReader(open('invoices.csv'))); c = Counter((r['vendor'], r['amount'], r['po_number']) for r in rows); print([k for k, v in c.items() if v > 1])\\""}`;
  const py2 = `{"command": "python3 -c \\"import csv; from collections import Counter; rows = list(csv.DictReader(open('invoices.csv'))); c = Counter(r['invoice_no'] for r in rows); print([k for k, v in c.items() if v > 1])\\""}`;
  const err = `Traceback (most recent call last):
  File "<string>", line 1, in <module>
  File "<string>", line 1, in <genexpr>
KeyError: 'vendor'

exit status 1`;
  return [
    backgroundRefusal(1),
    modelCall(
      2,
      1300,
      2900,
      3200,
      410,
      'The response asked for two tool calls at once: head and python3.',
    ),
    event(3, {
      kind: 'tool',
      atMs: 4200,
      title: 'terminal',
      summary: 'head invoices.csv',
      durationMs: 400,
      input: '{"command": "head invoices.csv"}',
      output: HEAD_OUTPUT,
      outputChars: 742,
    }),
    event(4, {
      kind: 'tool',
      atMs: 4600,
      title: 'terminal',
      summary: `python3 -c "import csv … r['vendor'] …"`,
      durationMs: 1200,
      error: true,
      input: py1,
      output: err,
      outputChars: 214,
    }),
    modelCall(5, 6000, 13300, 3900, 620),
    event(6, {
      kind: 'tool',
      atMs: 19500,
      title: 'terminal',
      summary: `python3 -c "… Counter(r['invoice_no'] …)" (retry)`,
      durationMs: 1100,
      input: py2,
      output: '[]',
      outputChars: 2,
    }),
    modelCall(7, 20800, 30600, 4300, 870, 'Streams the text and the final response.'),
    event(8, {
      kind: 'text',
      atMs: 31000,
      title: 'text',
      summary: 'No invoice number appears more than once, so there are no duplicate invoices.',
      text: 'No invoice number appears more than once, so there are no duplicate invoices.',
    }),
    event(9, {
      kind: 'final',
      atMs: 51600,
      title: 'final response',
      summary: 'I checked invoices.csv for invoices that appear more than once. …',
      text: 'See section 3, Final response, for the full text and the extracted answer.',
    }),
  ];
}

/** The running run's timeline: 14 events so far, the last one still open. */
function runningTimeline(): TimelineEvent[] {
  const tool = (
    seq: number,
    atMs: number,
    title: string,
    summary: string,
    durationMs: number | null,
    server: string | null = null,
    running = false,
  ) =>
    event(seq, {
      kind: 'tool',
      atMs,
      title,
      server,
      summary,
      durationMs,
      running,
      input: summary.startsWith('{') ? summary : JSON.stringify({ path: summary }),
      output: running ? null : '…',
    });
  const text = (seq: number, atMs: number, t: string) =>
    event(seq, { kind: 'text', atMs, title: 'text', summary: t, text: t });
  return [
    text(1, 1800, 'Reading the task: convert every open invoice to EUR with rates.json.'),
    tool(2, 3400, 'list_invoices', '{"status": "open"}', 700, 'invoice-db'),
    text(3, 5200, '48 open invoices across EUR, USD and GBP.'),
    tool(4, 6900, 'read_file', 'invoices.csv', 100),
    tool(5, 8400, 'get_invoice', '{"id": "INV-1042"}', 200, 'invoice-db'),
    text(6, 11800, 'Checking which currencies need conversion.'),
    tool(7, 13600, 'terminal', 'cut -d, -f6 invoices.csv | sort | uniq -c', 300),
    tool(8, 16200, 'list_invoices', '{"currency": "GBP"}', 500, 'invoice-db'),
    text(9, 19700, '6 GBP invoices. Next, the USD ones.'),
    tool(10, 21300, 'get_invoice', '{"id": "INV-1088"}', 200, 'invoice-db'),
    tool(11, 24900, 'list_invoices', '{"currency": "USD"}', 600, 'invoice-db'),
    text(12, 29300, '14 USD invoices. Loading rates.json to convert them to EUR.'),
    tool(13, 31700, 'read_file', 'rates.json', 100),
    tool(14, 36200, 'get_invoice', '{"id": "INV-1094"}', null, 'invoice-db', true),
  ];
}

/** The cancelled run's timeline, ending with the cancel marker. */
function cancelledTimeline(): TimelineEvent[] {
  return [
    backgroundRefusal(1),
    modelCall(2, 1200, 3100, 2400, 210),
    event(3, {
      kind: 'tool',
      atMs: 4800,
      title: 'list_invoices',
      server: 'invoice-db',
      summary: '{"status": "open"}',
      durationMs: 800,
      input: '{"status": "open"}',
      output: '[{"id": "INV-0981", "vendor": "Brightline Freight", …}, …]',
      outputChars: 3610,
    }),
    modelCall(4, 6100, 14200, 2650, 380),
    event(5, {
      kind: 'tool',
      atMs: 22400,
      title: 'write_file',
      summary: 'summary.csv (3 rows)',
      durationMs: 100,
      input: '{"path": "summary.csv"}',
      output: 'wrote 118 bytes',
      outputChars: 15,
    }),
    event(6, {
      kind: 'tool',
      atMs: 27900,
      title: 'list_invoices',
      server: 'invoice-db',
      summary: '{"vendor": "Norvale Logistics"}',
      durationMs: 700,
      input: '{"vendor": "Norvale Logistics"}',
      output: '[{"id": "INV-0994", …}, {"id": "INV-1024", …}]',
      outputChars: 412,
    }),
    event(7, {
      kind: 'platform',
      atMs: 31000,
      title: 'cancelled',
      summary: 'Cancelled at 00:31 · experiment cancelled by user',
      text: 'Cancelled at 00:31 · experiment cancelled by user',
    }),
  ];
}

/** A plausible timeline for any other run, with model-call tokens that add up to the header. */
function genericTimeline(seed: ExperimentSeed, run: RunSeed): TimelineEvent[] {
  const tokens = run.tokens ?? { input: 12000, output: 1800, total: 13800 };
  const split = [0.28, 0.34, 0.38];
  const ins = split.map((f) => Math.round(tokens.input * f));
  const outs = split.map((f) => Math.round(tokens.output * f));
  ins[2] = tokens.input - (ins[0] ?? 0) - (ins[1] ?? 0);
  outs[2] = tokens.output - (outs[0] ?? 0) - (outs[1] ?? 0);
  const durS = Math.max(run.durationS ?? 40, 12);
  const ms = (f: number) => Math.round(durS * 1000 * f);
  const usesSkill = run.config === 'with-skill';
  const usesMcp = run.config === 'with-mcp';
  const events: TimelineEvent[] = [
    backgroundRefusal(1),
    modelCall(2, 1300, ms(0.06), ins[0] ?? 0, outs[0] ?? 0),
  ];
  events.push(
    usesMcp
      ? event(3, {
          kind: 'tool',
          atMs: ms(0.1),
          title: 'list_invoices',
          server: 'invoice-db',
          summary: '{"status": "open"}',
          durationMs: 700,
          input: '{"status": "open"}',
          output: '[{"id": "INV-0981", "vendor": "Brightline Freight", …}, …]',
          outputChars: 3610,
        })
      : event(3, {
          kind: 'tool',
          atMs: ms(0.1),
          title: usesSkill ? 'read_file' : 'terminal',
          summary: usesSkill ? 'invoices.csv' : 'head invoices.csv',
          durationMs: usesSkill ? 100 : 400,
          input: usesSkill ? '{"path": "invoices.csv"}' : '{"command": "head invoices.csv"}',
          output: HEAD_OUTPUT,
          outputChars: 742,
        }),
  );
  if (is(seed, run, 'skillVsNoSkill', 'currency_mix', 'with-skill', 2)) {
    events.push(
      event(4, {
        kind: 'tool',
        atMs: 14200,
        title: 'terminal',
        summary: 'curl -s https://example.com/fx/eur-usd.json',
        durationMs: 200,
        error: true,
        input: '{"command": "curl -s https://example.com/fx/eur-usd.json"}',
        output: 'curl: (56) CONNECT tunnel failed, response 403\nexit status 56',
        outputChars: 62,
        refusal: { host: 'example.com', port: 443, reason: 'not on the allowlist' },
      }),
    );
  }
  const n = events.length;
  events.push(modelCall(n + 1, ms(0.2), ms(0.25), ins[1] ?? 0, outs[1] ?? 0));
  if (run.status === 'execution_error' && run.category === 'timeout') {
    events.push(
      event(n + 2, {
        kind: 'tool',
        atMs: ms(0.5),
        title: usesMcp ? 'list_invoices' : 'terminal',
        server: usesMcp ? 'invoice-db' : null,
        summary: usesMcp ? '{"currency": "USD"}' : 'python3 reconcile.py --exclude-disputed',
        durationMs: null,
        running: true,
        input: usesMcp
          ? '{"currency": "USD"}'
          : '{"command": "python3 reconcile.py --exclude-disputed"}',
      }),
      event(n + 3, {
        kind: 'platform',
        atMs: 300000,
        title: 'killed',
        summary: 'Time budget 300 s reached; container stopped',
        text: 'The worker stopped the container at the deadline (SIGTERM, SIGKILL after 10 s). No result event, so a platform result was recorded.',
      }),
    );
    return events;
  }
  if (run.status === 'execution_error') {
    events.push(
      event(n + 2, {
        kind: 'platform',
        atMs: ms(0.9),
        title: 'killed',
        summary:
          run.category === 'other' ? 'Disk limit passed: 2 GB · container stopped' : 'Run stopped',
        text:
          run.category === 'other'
            ? 'The workspace passed the 2 GB disk cap; the worker stopped the container.'
            : null,
      }),
    );
    return events;
  }
  events.push(
    event(n + 2, {
      kind: 'tool',
      atMs: ms(0.48),
      title: 'terminal',
      summary: 'python3 -c "import csv … "',
      durationMs: 1100,
      input: '{"command": "python3 -c \\"import csv …\\""}',
      output: '…',
      outputChars: 380,
    }),
    modelCall(
      n + 3,
      ms(0.52),
      ms(0.4),
      ins[2] ?? 0,
      outs[2] ?? 0,
      'Streams the text and the final response.',
    ),
    event(n + 4, {
      kind: 'final',
      atMs: ms(0.98),
      title: 'final response',
      summary: 'See Final response.',
      text: 'See section 3, Final response, for the full text and the extracted answer.',
    }),
  );
  return events;
}

// ---------------------------------------------------------------------------
// Final response
// ---------------------------------------------------------------------------

function valueAt(value: JsonValue, path: string): JsonValue | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value[path];
  return undefined;
}

/** A wrong answer of the right shape: what a failed run plausibly returned. */
function perturb(value: JsonValue): JsonValue {
  if (typeof value === 'number') return Math.round(value * 99) / 100;
  if (Array.isArray(value)) return value.slice(0, Math.max(0, value.length - 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return Object.fromEntries(entries.slice(0, Math.max(0, entries.length - 1)));
  }
  if (typeof value === 'string') return value.split(', ').slice(0, -1).join(', ');
  return value;
}

/** JSON on one line with the spacing people write: {"duplicates": [["INV-0988", "INV-1131"]]}. */
export function inlineJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value);
}

function withFence(intro: string, answer: JsonValue) {
  const open = '```json\n';
  const body = inlineJson(answer);
  const text = `${intro}\n${open}${body}\n\`\`\``;
  const fenceStart = intro.length + 1;
  const start = fenceStart + open.length;
  return {
    text,
    extracted: { start, end: start + body.length },
    fence: { start: fenceStart, end: text.length },
  };
}

function finalResponseFor(seed: ExperimentSeed, run: RunSeed): FinalResponseView | null {
  if (run.status !== 'scored') return null;
  const task = taskSeed(run.taskKey);
  const reference = task.reference;
  if (is(seed, run, 'skillVsNoSkill', 'dup_invoices', 'baseline', 3)) {
    const f = withFence(
      'I checked invoices.csv for invoices that appear more than once.\nEach invoice number is unique, so no invoice was billed twice.',
      { duplicates: [] },
    );
    return {
      ...f,
      extraction: 'found',
      parsed: { duplicates: [] },
      parseError: null,
      reference,
      referenceNote:
        'Each pair has the same vendor, amount and PO number under different invoice numbers. That is why comparing invoice numbers found nothing.',
    };
  }
  if (run.primaryStatus === 'ungradable') {
    return {
      text: `I applied each credit note to the invoice it references. Net balances:\n\n| invoice | net balance |\n| --- | --- |\n| INV-1031 | 310.00 |\n| INV-1054 | 0.00 |\n| INV-1066 | 1,412.50 |\n| INV-1088 | 2,480.00 |`,
      extracted: null,
      fence: null,
      extraction: 'missing',
      parsed: null,
      parseError: null,
      reference,
      referenceNote: null,
    };
  }
  const path =
    Object.keys(
      reference && typeof reference === 'object' && !Array.isArray(reference) ? reference : {},
    )[0] ?? '';
  const answer =
    run.primaryStatus === 'failed' && path
      ? {
          ...(reference as Record<string, JsonValue>),
          [path]: perturb(valueAt(reference, path) ?? null),
        }
      : reference;
  const f = withFence(
    `I worked through ${task.fixtures.map((x) => x.path).join(' and ')} and checked the result.`,
    answer,
  );
  return {
    ...f,
    extraction: 'found',
    parsed: answer,
    parseError: null,
    reference,
    referenceNote: null,
  };
}

// ---------------------------------------------------------------------------
// Scores and notices
// ---------------------------------------------------------------------------

const PASS_COMMENTS: Record<string, string> = {
  credit_notes: 'all 14 net balances match the reference',
  per_vendor: '5 vendors, totals match the reference',
};

const KEY_COMMENTS: Record<string, { passed: string; failed: string }> = {
  reads_fixture: {
    passed: 'read_file called on invoices.csv',
    failed:
      'no read_file call on invoices.csv; the file was only read through terminal (head, python3)',
  },
  uses_db: {
    passed: 'trajectory_match: mcp__invoice_db__list_invoices called 3 times (required ≥ 1)',
    failed: 'no tool mcp__invoice_db__list_invoices available',
  },
  method: {
    passed: 'llm_judge: applies every credit note to its invoice before totalling',
    failed: 'llm_judge: totals the invoices before applying the credit notes',
  },
  rationale: {
    passed: 'llm_judge: names the dispute flag as the exclusion rule',
    failed: 'llm_judge: does not say which rule excluded the invoices',
  },
  check: {
    passed: 'verifier printed score 1: fees match policy_terms.json',
    failed: 'verifier printed score 0: fees do not match policy_terms.json',
  },
  totals: {
    passed: 'total_vat within ±0.01 of the reference',
    failed: 'total_vat off by 41.20',
  },
  summary: {
    passed: 'summary.csv has columns vendor, outstanding and 5 rows',
    failed: 'summary.csv has 4 rows; expected 5',
  },
};

const JUDGE_ERROR = {
  message: 'llm_judge could not reach the provider',
  detail: 'POST https://inference-api.nousresearch.com/v1/chat/completions → 503 after 3 attempts',
};

/** One judge call's usage, as egress meters it: the rubric, the reply and the agent's text in, a verdict out. */
const JUDGE_TOKENS = { input: 1840, output: 212, total: 2052 };

/** The judge's price, from the one priced model of PRICE_TABLE ($0.60 in / $2.40 out per 1M). */
const judgeCost = (t: { input: number; output: number }) =>
  Math.round((t.input * 0.6 + t.output * 2.4) / 1000) / 1000;

/**
 * The scorer's own detail behind a score, as GET /runs/:id carries it: the
 * judge's call for llm_judge, the counted calls for trajectory_match, the
 * matched keys or items for json_match. A failed json_match misses the
 * element perturb() drops, the last one.
 */
function evidenceFor(
  k: { key: string; type: ScoreRowView['type']; status: ScoreRowView['status'] },
  params: Record<string, JsonValue>,
  expected: JsonValue | undefined,
  sample: boolean,
): ScoreRowView['evidence'] {
  const evidence: ScoreRowView['evidence'] = {
    eventSeqs: sample && k.key === 'answer' ? [9] : [],
    artifactIds: [],
    judge: null,
    trajectory: null,
    text: null,
    jsonMatch: null,
  };
  if (k.type === 'llm_judge' && k.status !== 'ungradable') {
    const failedCall = k.status === 'error';
    const tokens = failedCall ? { input: 0, output: 0, total: 0 } : JUDGE_TOKENS;
    evidence.judge = {
      provider: 'nous',
      baseUrl: null,
      model: MODEL,
      calls: 2,
      tokens,
      costUsd: judgeCost(tokens),
      latencyMs: failedCall ? 2 * 1180 : 1180 + 4920,
      finishReason: failedCall ? null : 'stop',
      callLog: failedCall
        ? [
            { status: 503, latencyMs: 1180 },
            { status: 503, latencyMs: 1180 },
          ]
        : [
            { status: 503, latencyMs: 1180 },
            { status: 200, latencyMs: 4920 },
          ],
    };
  } else if (k.type === 'trajectory_match' && k.status !== 'error') {
    const passed = k.status === 'passed';
    evidence.trajectory = {
      tool: typeof params.tool === 'string' ? params.tool : 'read_file',
      calls: passed ? 3 : 0,
      matchedSeqs: passed ? [4, 9, 15] : [],
      mode: null,
    };
  } else if (k.type === 'json_match' && (k.status === 'passed' || k.status === 'failed')) {
    const path = typeof params.path === 'string' ? params.path : '';
    const items = Array.isArray(expected);
    const keys = expected !== null && typeof expected === 'object' && !items;
    const names = keys ? Object.keys(expected) : [];
    const total = items ? expected.length : keys ? names.length : 1;
    const missed = items
      ? `${path}[${total - 1}]`
      : keys
        ? `${path}.${names[names.length - 1]}`
        : path;
    const sampleMiss = sample && items;
    evidence.jsonMatch = {
      unit: items ? 'items' : keys ? 'keys' : 'value',
      matched: k.status === 'passed' ? total : sampleMiss ? 0 : total - 1,
      total,
      mismatches:
        k.status === 'passed'
          ? []
          : sampleMiss
            ? Array.from({ length: total }, (_, i) => `${path}[${i}]`)
            : [missed],
    };
  }
  return evidence;
}

function shortJson(value: JsonValue | undefined): string {
  const s = JSON.stringify(value ?? null);
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
}

function scoreRows(seed: ExperimentSeed, run: RunSeed): ScoreRowView[] {
  const verification = taskVerification(run.taskKey);
  const reference = taskSeed(run.taskKey).reference;
  const sample = is(seed, run, 'skillVsNoSkill', 'dup_invoices', 'baseline', 3);
  return keyResults(seed, run).map((k) => {
    const v = verification.find((x) => x.key === k.key);
    const sentence = (v?.sentence ?? k.type).replace(/, pass at [\d.]+$/, '');
    const path = typeof v?.params.path === 'string' ? v.params.path : null;
    let comment: string;
    if (k.primary) {
      comment =
        k.status === 'passed'
          ? (PASS_COMMENTS[run.taskKey] ?? 'answer matched the reference')
          : (runComment(run) ?? '');
      if (sample) comment = SAMPLE_RUN_COMMENT;
    } else if (k.status === 'error') {
      comment = JUDGE_ERROR.message;
    } else {
      const c = KEY_COMMENTS[k.key];
      comment = c ? (k.status === 'passed' ? c.passed : c.failed) : '';
    }
    let expected: ScoreRowView['expected'] = null;
    let observed: ScoreRowView['observed'] = null;
    if (sample && k.key === 'answer') {
      expected = { summary: '2 pairs', detail: '[INV-1042, INV-1107]\n[INV-0988, INV-1131]' };
      observed = { summary: '0 pairs', detail: '[]' };
    } else if (sample && k.key === 'reads_fixture') {
      expected = { summary: '≥ 1 call', detail: null };
      observed = { summary: '0 calls', detail: null };
    } else if (k.primary && path && k.status !== 'ungradable') {
      const exp = valueAt(reference, path);
      expected = { summary: shortJson(exp), detail: null };
      observed = {
        summary: shortJson(k.status === 'passed' ? exp : perturb(exp ?? null)),
        detail: null,
      };
    } else if (k.type === 'trajectory_match') {
      expected = { summary: '≥ 1 call', detail: null };
      observed = { summary: k.status === 'passed' ? '3 calls' : '0 calls', detail: null };
    }
    return {
      key: k.key,
      type: k.type,
      primary: k.primary,
      sentence:
        sample && k.key === 'reads_fixture'
          ? 'trajectory_match: read_file on invoices.csv'
          : sentence,
      status: k.status,
      score: k.score,
      expected,
      observed,
      comment,
      error: k.status === 'error' ? JUDGE_ERROR : null,
      evidence: evidenceFor(
        k,
        v?.params ?? {},
        path ? valueAt(reference, path) : undefined,
        sample,
      ),
    };
  });
}

function outcomeNoticeFor(run: RunSeed, scores: ScoreRowView[]): OutcomeNotice | null {
  const ungradable = scores.find((s) => s.status === 'ungradable');
  if (ungradable) {
    return {
      kind: 'ungradable',
      title: 'no fenced JSON block found in final response',
      detail:
        run.taskKey === 'credit_notes'
          ? 'The response ends with a Markdown table of balances and no ```json block. See Final response, where the whole text is shown with nothing highlighted.'
          : 'The response has no ```json block. See Final response, where the whole text is shown with nothing highlighted.',
      request: null,
      key: ungradable.key,
    };
  }
  const error = scores.find((s) => s.status === 'error');
  if (error) {
    return {
      kind: 'error',
      title: 'Scorer error: llm_judge could not reach the provider',
      detail: `Key ${error.key} · the agent's output is stored · Re-score runs only the scorers`,
      request: JUDGE_ERROR.detail,
      key: error.key,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execution errors and attempts
// ---------------------------------------------------------------------------

function executionErrorFor(
  seed: ExperimentSeed,
  run: RunSeed,
  active: Active,
): ExecutionErrorView | null {
  if (run.status !== 'execution_error') return null;
  if (is(seed, run, 'skillVsNoSkill', 'disputed', 'baseline', 4) && active('timeout-silent')) {
    return {
      category: 'timeout',
      reason:
        'Stopped at the time limit (300 s budget plus grace). The run printed nothing, and was still stopped on time',
      meta: 'stopped at 310 s',
      explanation:
        'No event arrived from Hermes during the whole run. The worker enforces the deadline itself, so a silent run cannot overrun it.',
      stderrTail: {
        lines: [
          '[10:37:20] worker: container started · deadline 310 s',
          '[10:42:20] worker: deadline reached; SIGTERM sent',
          '[10:42:30] worker: SIGKILL after 10 s',
          '[10:42:30] worker: no result event; platform result recorded (timeout)',
        ],
        totalLines: 4,
      },
      exitCode: 137,
    };
  }
  if (run.taskKey === 'disputed' && seed.key === 'skillVsNoSkill') {
    return {
      category: 'timeout',
      reason: 'No final response within the 300 s time budget.',
      meta: null,
      explanation:
        'The agent was waiting on a terminal call (python3 reconcile.py) that had been running for 212 s. Both attempts timed out at the same step, so a third retry will probably time out too.',
      stderrTail: {
        lines: [
          '[10:49:28] tool terminal: python3 reconcile.py --exclude-disputed (started)',
          '[10:51:00] tool terminal: still running after 92 s',
          '[10:51:19] hermes: time budget 300 s reached; sending SIGTERM to tool process 4127',
          '[10:51:20] hermes: tool process 4127 exited (signal 15)',
          '[10:51:20] hermes: no final response; partial transcript written to /trial/home/transcript.jsonl',
          '[10:51:20] hermes: exit 124 (timeout)',
        ],
        totalLines: 1204,
      },
      exitCode: 124,
    };
  }
  switch (run.category) {
    case 'other':
      return {
        category: 'other',
        reason: 'Stopped: the run wrote more than 2 GB to its workspace (disk limit)',
        meta: 'after 41 s · workspace 2.0 GB, 1,318 files',
        explanation:
          'The disk cap is 2 GB and 50,000 files per run. The agent kept writing copies of summary.csv under different names.',
        stderrTail: {
          lines: [
            '[10:31:02] worker: workspace 1.5 GB, 1,004 files',
            '[10:31:09] worker: workspace 2.0 GB, 1,318 files: disk cap passed',
            '[10:31:09] worker: container stopped (stopReason: disk_limit)',
          ],
          totalLines: 3,
        },
        exitCode: 137,
      };
    case 'provider':
      return {
        category: 'provider',
        reason:
          'Nous Portal login lapsed during the run. Retried automatically after the experiment resumed',
        meta: 'attempt 1 stopped at 22 s · no attempt counted against the run',
        explanation: null,
        stderrTail: {
          lines: [
            'POST http://egress:8080/v1/chat/completions → 401 · Nous Portal login needs renewing',
            'hermes: provider error (401); exit 1',
          ],
          totalLines: 2,
        },
        exitCode: 1,
      };
    case 'setup':
      return {
        category: 'setup',
        reason: 'invoice-db failed to start',
        meta: null,
        explanation:
          'The MCP server exited before Hermes finished starting, with the same first stderr line in all 14 runs. Check that INVOICE_DB_URL is set on the worker (Resources › Secrets).',
        stderrTail: {
          lines: [
            'Error: INVOICE_DB_URL is not set',
            '    at loadConfig (/usr/lib/node_modules/invoice-db-mcp/dist/config.js:12:11)',
            'hermes: MCP server invoice-db failed to start (exit 1)',
            'hermes: exit 3 (setup)',
          ],
          totalLines: 4,
        },
        exitCode: 3,
      };
    case 'limit':
      return {
        category: 'limit',
        reason: 'Stopped at the token cap: 2,000,000 model tokens in this attempt',
        meta: 'after 214 s · 2,000,418 tokens metered by the model gateway',
        explanation:
          'The model gateway refuses every model call (402, which Hermes does not retry) once an attempt has used its token cap (MODEL_TOKEN_CAP_PER_ATTEMPT). The agent kept re-reading invoices.csv into its context. A limit is never retried automatically: Retry execution starts a new attempt with a fresh cap.',
        stderrTail: {
          lines: [
            'POST http://egress:8080/v1/chat/completions → 402 · token cap of 2000000 reached for this attempt',
            'hermes: provider error (402); exit 1',
          ],
          totalLines: 2,
        },
        exitCode: 1,
      };
    case 'worker_lost':
      return {
        category: 'worker_lost',
        reason: 'The worker stopped heartbeating while this run was in flight',
        meta: 'last heartbeat 15:31:04',
        explanation:
          'Recovery marked the attempt execution_error. Retry it once a worker is connected.',
        stderrTail: {
          lines: ['recovery: lease expired; attempt marked execution_error · worker_lost'],
          totalLines: 1,
        },
        exitCode: null,
      };
    default:
      return {
        category: 'timeout',
        reason: 'No final response within the 300 s time budget.',
        meta: null,
        explanation:
          run.config === 'with-mcp'
            ? 'invoice-db list_invoices was still open when the budget ran out.'
            : 'The last tool call was still running when the budget ran out.',
        stderrTail: {
          lines: [
            run.config === 'with-mcp'
              ? 'tool mcp__invoice_db__list_invoices {"currency": "USD"} (started)'
              : 'tool terminal: python3 -c "…" (started)',
            'hermes: time budget 300 s reached; sending SIGTERM',
            'hermes: no final response; partial transcript written to /trial/home/transcript.jsonl',
            'hermes: exit 124 (timeout)',
          ],
          totalLines: 212,
        },
        exitCode: 124,
      };
  }
}

function attemptsFor(seed: ExperimentSeed, run: RunSeed): AttemptView[] {
  const count = Math.max(run.attempts, run.status === 'queued' ? 0 : 1);
  if (!count) return [];
  const start = run.startedAt ?? run.finishedAt ?? seed.createdAt;
  if (is(seed, run, 'skillVsNoSkill', 'disputed', 'baseline', 4) && count === 2) {
    const first: AttemptView = {
      number: 1,
      trigger: 'initial',
      status: 'execution_error',
      category: 'timeout',
      startedAt: at(22, '10:37:10'),
      durationS: 300,
      exitCode: 124,
      countsAgainstRun: true,
    };
    const second: AttemptView =
      run.status === 'scored'
        ? {
            number: 2,
            trigger: 'user_retry',
            status: 'scored',
            category: null,
            startedAt: at(23, '14:20:05'),
            durationS: 71,
            exitCode: 0,
            countsAgainstRun: true,
          }
        : {
            number: 2,
            trigger: 'auto_retry',
            status: 'execution_error',
            category: 'timeout',
            startedAt: at(22, '10:46:20'),
            durationS: 300,
            exitCode: 124,
            countsAgainstRun: true,
          };
    return [first, second];
  }
  if (run.category === 'provider' && count === 2) {
    return [
      {
        number: 1,
        trigger: 'initial',
        status: 'execution_error',
        category: 'provider',
        startedAt: addSeconds(start, -240),
        durationS: 22,
        exitCode: 1,
        countsAgainstRun: false,
      },
      {
        number: 2,
        trigger: 'auto_retry',
        status: 'execution_error',
        category: 'provider',
        startedAt: start,
        durationS: run.durationS,
        exitCode: 1,
        countsAgainstRun: false,
      },
    ];
  }
  const list: AttemptView[] = [];
  for (let n = 1; n <= count; n++) {
    const last = n === count;
    const status: AttemptView['status'] = last
      ? run.status === 'scored'
        ? 'scored'
        : run.status === 'execution_error'
          ? 'execution_error'
          : run.status === 'cancelled'
            ? 'cancelled'
            : run.status === 'running'
              ? 'running'
              : 'executed'
      : 'execution_error';
    list.push({
      number: n,
      trigger: n === 1 ? 'initial' : 'user_retry',
      status,
      category: status === 'execution_error' ? (last ? run.category : 'timeout') : null,
      startedAt: last ? start : addSeconds(start, -600 * (count - n)),
      durationS: last ? run.durationS : 300,
      exitCode:
        status === 'scored' || status === 'executed'
          ? 0
          : status === 'execution_error'
            ? 124
            : null,
      countsAgainstRun: true,
    });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Artifacts and launch record
// ---------------------------------------------------------------------------

const SUMMARY_PREVIEW: TablePreview = {
  columns: ['vendor', 'outstanding'],
  rows: [
    ['Brightline Freight', '6,215.00'],
    ['Kestrel Office Supply', '1,486.65'],
    ['Halden Print Co.', '558.90'],
  ],
  totalRows: 3,
};

function artifactsFor(run: RunSeed, active: Active): ArtifactsView {
  if (run.status === 'queued' || run.status === 'running') {
    return { items: [], note: 'collected when the run ends', agentWroteNothing: false };
  }
  const agentSummary = (
    rows: number,
    sizeBytes: number,
    hash: string,
    preview: TablePreview,
  ): ArtifactView => ({
    id: ulid('art', `${run.id}:summary.csv`),
    root: 'workspace',
    path: 'workspace/summary.csv',
    origin: 'agent',
    sizeBytes,
    sha256: hash,
    skippedReason: null,
    preview: { ...preview, totalRows: rows },
  });
  if (run.status === 'cancelled') {
    const items =
      run.taskKey === 'summary_file'
        ? [agentSummary(3, 118, sha('summary.csv-cancelled', 'a7f2c019', '44be'), SUMMARY_PREVIEW)]
        : [];
    return { items, note: 'partial · written before the cancel', agentWroteNothing: !items.length };
  }
  const fixtures: ArtifactView[] = taskSeed(run.taskKey).fixtures.map((f) => ({
    id: ulid('art', `${run.id}:${f.path}`),
    root: 'workspace',
    path: `workspace/${f.path}`,
    origin: 'fixture_unchanged',
    sizeBytes: f.sizeBytes,
    sha256: f.sha256,
    skippedReason: null,
    preview: f.path === 'invoices.csv' ? INVOICES_PREVIEW : null,
  }));
  const items = [...fixtures, ...homeArtifactsFor(active, run)];
  if (run.taskKey === 'summary_file' && run.status === 'scored') {
    const rows = run.primaryStatus === 'passed' ? 5 : 4;
    items.push(
      agentSummary(rows, rows === 5 ? 196 : 158, sha(`${run.id}:summary.csv`), {
        ...SUMMARY_PREVIEW,
        rows: [
          ...SUMMARY_PREVIEW.rows,
          ['Norvale Logistics', '3,465.00'],
          ...(rows === 5 ? [['Orbis Facilities', '2,120.40']] : []),
        ],
      }),
    );
  }
  // As the API: about the workspace only, whatever the home's memory files say.
  const wrote = items.some((a) => a.root === 'workspace' && a.origin === 'agent');
  return { items, note: null, agentWroteNothing: !wrote };
}

const CONFIG_YAML_BASE = `model:
  default: openai/gpt-6.1-sol
  provider: nous
  base_url: http://egress:8080/v1
toolsets: [file, terminal]
memory:
  memory_enabled: false
  user_profile_enabled: false
  nudge_interval: 10
skills:
  creation_nudge_interval: 10
mcp_servers: {}
agent:
  max_turns: 20
  run_budget_seconds: 300
approvals:
  mode: "off"
updates:
  check: false`;

const MCP_YAML = `mcp_servers:
  invoice-db:
    command: npx
    args: [invoice-db-mcp]
    env: { INVOICE_DB_URL: <from env INVOICE_DB_URL> }
    tools: { include: [list_invoices, get_invoice] }
    timeout_s: 30`;

function launchRecordFor(run: RunSeed, active: Active): LaunchRecordView {
  const config = configVersionIn(active, run.config);
  const withSkill = config.skills.length > 0;
  const withMcp = config.mcpServers.length > 0;
  const onDemand = withSkill && config.skillLoading === 'on_demand';
  // On demand passes no -s and adds the skills toolset, so the agent finds the skill itself.
  const tools = onDemand
    ? '-t file,terminal,skills'
    : `-t file,terminal${withSkill ? ' -s invoice-method' : ''}`;
  return {
    container: {
      image: 'nousresearch/hermes-agent:v0.22.4',
      digest: sha('hermes-agent-image', '7a6920'),
      hermes: 'hermes-agent v0.22.4 @ 4d04303',
      network: 'hermes-evals-trial-1',
      user: '10000',
      imageFilesystem: 'read-only',
      limits: { memory: '1.5 GB', cpus: 1, processes: 1024, tmp: '512 MB' },
      mounts: [
        { name: 'home', target: '/opt/data' },
        { name: 'workspace', target: '/workspace' },
      ],
      diskCap: { bytes: 2 * 1024 ** 3, files: 50000 },
      worker: {
        name: 'worker-1',
        startedAt: run.startedAt ?? run.finishedAt ?? at(22, '10:20:15'),
        exitCode:
          run.status === 'execution_error'
            ? run.category === 'timeout'
              ? 124
              : 1
            : run.status === 'scored'
              ? 0
              : null,
      },
      skills: withSkill
        ? [
            {
              name: SKILL_INVOICE_METHOD.name,
              version: SKILL_INVOICE_METHOD.version,
              contentHash: SKILL_INVOICE_METHOD.contentHash,
            },
          ]
        : [],
      skillLoading: config.skillLoading,
      mcpServers: withMcp
        ? [
            {
              name: MCP_INVOICE_DB.name,
              version: MCP_INVOICE_DB.version,
              transport: MCP_INVOICE_DB.transport,
              definition: MCP_YAML,
            },
          ]
        : [],
    },
    command: `hermes chat --query-file /opt/data/task.txt --oneshot --format stream-json \\
  --provider nous -m openai/gpt-6.1-sol \\
  --base-url http://egress:8080/v1 --api-key ‹run token, revoked› \\
  ${tools} --max-turns 20 --yolo --in /workspace`,
    commandNote:
      run.config === 'baseline'
        ? `The with-skill counterpart adds ${configVersionIn(active, 'with-skill').skillLoading === 'on_demand' ? 'the skills toolset (its skill loads on demand)' : '-s invoice-method after -t file,terminal'}. The run token is issued for this run only and revoked when it ends.`
        : onDemand
          ? 'invoice-method is installed in the home without -s; the skills toolset lets the agent list and open it. The run token is issued for this run only and revoked when it ends.'
          : 'The run token is issued for this run only and revoked when it ends.',
    configPath: '/opt/data/config.yaml',
    configYaml: withMcp ? CONFIG_YAML_BASE.replace('mcp_servers: {}', MCP_YAML) : CONFIG_YAML_BASE,
    configNote:
      'Plus settings that keep runs identical across configurations: plugins, curator and title generation off.',
    homeSeeds: homeSeedsFor(active, run),
    backgroundReview: { memoryNudgeInterval: 10, skillCreationNudgeInterval: 10 },
  };
}

// ---------------------------------------------------------------------------
// Counterpart and the whole detail
// ---------------------------------------------------------------------------

function counterpartFor(seed: ExperimentSeed, run: RunSeed): CounterpartView | null {
  const other = run.config === seed.baseline ? seed.candidates[0] : seed.baseline;
  if (!other) return null;
  const twin = runsOf(seed).find(
    (r) => r.taskKey === run.taskKey && r.config === other && r.repetition === run.repetition,
  );
  if (!twin) return null;
  const finished = twin.status === 'scored' || twin.status === 'execution_error';
  return {
    runId: twin.id,
    configuration: other,
    status: twin.status,
    unavailableReason: finished
      ? null
      : twin.status === 'cancelled'
        ? 'Counterpart run was cancelled'
        : `Counterpart run is not scored yet (${twin.status})`,
  };
}

/**
 * Which evaluation the scores come from. Fixture runs are graded once: a
 * scored run shows generation 1, and an executed or scoring run its first
 * evaluation in flight.
 */
function evaluationFor(run: RunSeed): RunEvaluationView {
  const inFlight = run.status === 'executed' || run.status === 'scoring';
  return {
    generation: run.status === 'scored' ? 1 : null,
    pending: inFlight
      ? {
          evaluationId: `eval_${run.id.replace(/^run_/, '')}_1`,
          generation: 1,
          status: run.status === 'scoring' ? 'running' : 'queued',
          cause: 'initial',
          requestedAt: run.finishedAt ?? run.startedAt ?? at(23, '15:30:00'),
        }
      : null,
    lastFailure: null,
  };
}

/** The whole inspector detail of one run. */
export function runDetailFixture(active: Active, runId: string): RunDetail | null {
  const found = findRun(active, runId);
  if (!found) return null;
  const { seed, run } = found;
  const task = taskSeed(run.taskKey);
  const scores = scoreRows(seed, run);
  const sample = is(seed, run, 'skillVsNoSkill', 'dup_invoices', 'baseline', 3);
  const designedRunning =
    is(seed, run, 'mcpVsBaseline', 'currency_mix', 'with-mcp', 5) && run.status === 'running';
  const designedCancelled = run.status === 'cancelled' && run.taskKey === 'summary_file';
  let events: TimelineEvent[];
  if (sample) events = sampleTimeline();
  else if (designedRunning) events = runningTimeline();
  else if (designedCancelled) events = cancelledTimeline();
  else if (run.status === 'queued') events = [];
  else if (run.status === 'running') events = runningTimeline().slice(0, 6);
  else events = genericTimeline(seed, run);
  const attempts = attemptsFor(seed, run);
  return {
    id: run.id,
    experimentId: seed.id,
    experimentName: seed.name,
    suite: SUITE_V1_REF,
    task: { key: run.taskKey, version: 1, summary: task.summary },
    configuration: configRef(seed, run.config),
    repetition: run.repetition,
    status: run.status,
    attemptCount: attempts.length,
    shownAttempt: attempts.length,
    attempts,
    primary: { key: primaryKey(run.taskKey), status: run.primaryStatus },
    startedAt: run.startedAt,
    finishedAt: run.status === 'running' ? null : run.finishedAt,
    durationS: run.status === 'running' ? null : run.durationS,
    durationIsBudget:
      run.status === 'execution_error' && run.category === 'timeout' && run.durationS === 300,
    tokens: designedRunning
      ? { input: 9840, output: 1120, total: 10960 }
      : run.status === 'running'
        ? { input: 5210, output: 640, total: 5850 }
        : run.tokens,
    costUsd: run.status === 'running' ? null : run.costUsd,
    limits: { maxTurns: 20, budgetS: 300 },
    live:
      run.status === 'running'
        ? designedRunning
          ? { elapsedS: 38, turn: 6 }
          : { elapsedS: 21, turn: 3 }
        : null,
    cancelled:
      run.status === 'cancelled'
        ? {
            at: run.finishedAt ?? at(23, '15:31:04'),
            by: 'experiment',
            ranForS: run.durationS ?? 0,
          }
        : null,
    executionError: executionErrorFor(seed, run, active),
    outcomeNotice: outcomeNoticeFor(run, scores),
    evaluation: evaluationFor(run),
    scores,
    timeline: {
      events,
      live: run.status === 'running',
      totalEvents: designedRunning
        ? 14
        : run.status === 'execution_error' && run.taskKey === 'disputed'
          ? 23
          : events.length,
    },
    finalResponse: finalResponseFor(seed, run),
    artifacts: artifactsFor(run, active),
    launchRecord: launchRecordFor(run, active),
    counterpart: counterpartFor(seed, run),
    needs: runNeeds(run),
  };
}

/** GET /runs/:id/events?after=: the events after a sequence number. */
export function runEventsFixture(active: Active, runId: string, after = 0): RunEventsPage | null {
  const detail = runDetailFixture(active, runId);
  if (!detail) return null;
  const events = detail.timeline.events.filter((e) => e.seq > after);
  return {
    events,
    lastSeq: events.length ? (events[events.length - 1]?.seq ?? after) : after,
    live: detail.timeline.live,
  };
}

/**
 * The content of one artifact as text: a memory file's text, or a table artifact's rows as
 * CSV (the fixtures store tables, not bytes). Null when there is neither.
 */
export function artifactTextFixture(
  active: Active,
  runId: string,
  artifactId: string,
): { text: string; truncated: boolean } | null {
  const artifact = runDetailFixture(active, runId)?.artifacts.items.find(
    (a) => a.id === artifactId,
  );
  if (!artifact) return null;
  const text = homeArtifactText(artifact);
  if (text !== null) return { text, truncated: false };
  const preview = artifact.preview;
  if (!preview) return null;
  return {
    text: [preview.columns, ...preview.rows].map((row) => row.join(',')).join('\n'),
    truncated: preview.totalRows > preview.rows.length,
  };
}

/** Preview of one artifact (CSV as a table), or null. */
export function artifactPreviewFixture(
  active: Active,
  runId: string,
  artifactId: string,
): TablePreview | null {
  const detail = runDetailFixture(active, runId);
  return detail?.artifacts.items.find((a) => a.id === artifactId)?.preview ?? null;
}

export { runKey };

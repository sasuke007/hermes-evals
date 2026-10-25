/**
 * The Comparison tab's sentences, written from the view's numbers (Comparison board: "How to
 * read this", the provisional banner, the sensitivity line, the empty filter). The board's
 * copy is the template; only the numbers, names and the verdict's direction change. The
 * not-computable sentences are the API's own (`statisticsUnavailable.message`).
 */
import type {
  ComparisonFilter,
  ComparisonRow,
  ComparisonView,
  SensitivityView,
} from '@/api/types/experiments';
import { formatCount, formatRate, formatSigned } from '@/lib/format';

/** The score key select's caption and title (Comparison board). */
export const SCORE_KEY_HELP =
  "Default: each task's primary check. Pick another key to compare on it, or 'any key failed'.";

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/** "three" for 3, digits from 11 on. */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** "[+0.117, +0.333]". */
export function intervalText(lo: number, hi: number): string {
  return `[${formatSigned(lo)}, ${formatSigned(hi)}]`;
}

/** A message's first sentence (bold on screen) and the rest. */
export function splitLead(message: string): { lead: string; rest: string } {
  const match = /^(.+?[.:])(\s+|$)/.exec(message);
  if (!match?.[1]) return { lead: message, rest: '' };
  return { lead: match[1], rest: message.slice(match[0].length) };
}

/** How many tasks the experiment compares: every row, whatever the filter shows. */
const taskCount = (view: ComparisonView): number => view.filterCounts.all;

export interface Reading {
  read1: string;
  read2: string;
}

/** Where a side's execution errors are: one sentence per side that has any. */
function executionErrorSentences(view: ComparisonView): string {
  const sides = [
    { name: view.baseline.name, side: 'baseline' as const, row: view.secondary[0] },
    { name: view.candidate.name, side: 'candidate' as const, row: view.secondary[1] },
  ];
  return sides
    .map(({ name, side, row }) => {
      const n = row?.executionErrors ?? 0;
      if (n === 0) return '';
      if (n > 1) {
        return ` ${n} ${name} cells are execution errors, not wrong answers. They count against ${name} here, and retrying them recomputes the verdict.`;
      }
      const where = locateExecutionError(view.rows, side);
      const at = where ? ` (${where.taskKey}, rep ${where.repetition})` : '';
      return ` One ${name} cell is an execution error, not a wrong answer${at}. It counts against ${name} here, and retrying it recomputes the verdict.`;
    })
    .join('');
}

function locateExecutionError(
  rows: readonly ComparisonRow[],
  side: 'baseline' | 'candidate',
): { taskKey: string; repetition: number } | null {
  for (const row of rows) {
    const cell = row[side].find((c) => c.runStatus === 'execution_error');
    if (cell) return { taskKey: row.taskKey, repetition: cell.repetition };
  }
  return null;
}

/** "How to read this": the two paragraphs under the interval. Null without statistics. */
export function statisticsReading(view: ComparisonView): Reading | null {
  const s = view.statistics;
  if (!s) return null;
  const tasks = taskCount(view);
  const base = view.baseline.name;
  const cand = view.candidate.name;
  const resamples = formatCount(s.resamples);
  const pct = Math.round(s.confidence * 100);
  const lo = formatSigned(s.lo);
  const hi = formatSigned(s.hi);
  const delta = formatSigned(s.observedDelta);

  if (s.verdict === 'provisional' || view.provisional) {
    const perSide = tasks * view.repetitions;
    return {
      read1: `These numbers come from the runs scored so far: ${view.passCounts.baseline.counted} of ${base}'s ${perSide} and ${view.passCounts.candidate.counted} of ${cand}'s ${perSide}. Pass rates are ${formatRate(view.passRates.baseline)} and ${formatRate(view.passRates.candidate)}. The ${tasks} tasks were resampled ${resamples} times over those runs only.`,
      read2: `The interval is recomputed as each run is scored, so it can still move either way, and no verdict is given until all ${view.progress.total} runs are scored. Read it as a progress check, not a result.`,
    };
  }
  if (s.verdict === 'inconclusive' || s.verdict === 'not_computable') {
    return {
      read1: `The ${tasks} tasks were resampled with replacement ${resamples} times. ${pct}% of the differences between ${cand} and ${base} fall between ${lo} and ${hi}, and the observed difference is ${delta}. Because the interval crosses zero, ${numberWord(view.repetitions)} repetitions cannot tell the two apart, so the verdict is inconclusive.`,
      read2: `Inconclusive does not mean equivalent: a real difference of that size could still exist.${executionErrorSentences(view)} More repetitions narrow the interval.`,
    };
  }
  const better = s.verdict === 'better';
  return {
    read1: `The ${tasks} tasks were resampled with replacement ${resamples} times. Each resample recomputed the difference in pass rate between ${cand} and ${base}, keeping each task's runs together. ${pct}% of those differences fall between ${lo} and ${hi}, and the observed difference is ${delta}. ${
      better
        ? 'Because the whole interval lies above zero, the improvement is unlikely to come from which runs happened to pass, so the verdict is better.'
        : 'Because the whole interval lies below zero, the drop is unlikely to come from which runs happened to pass, so the verdict is worse.'
    }`,
    read2:
      'An interval that crossed zero would give inconclusive. That does not mean the two are equivalent. It means this many runs cannot tell them apart, and a real difference of that size could still exist. More repetitions, or more tasks, narrow the interval.',
  };
}

/** The dashed banner over a provisional grid: "Still running: 87 of 120 runs scored." */
export function provisionalBanner(view: ComparisonView): { lead: string; rest: string } {
  const counts = `${view.progress.scored} of ${view.progress.total} runs scored.`;
  const lead =
    view.experimentStatus === 'paused'
      ? `Paused: ${counts}`
      : view.experimentStatus === 'failed'
        ? `Stopped: ${counts}`
        : `Still running: ${counts}`;
  return {
    lead,
    rest: 'Unscored cells show running, scoring or queued (dashed). Pass rates and Δ use the scored runs only, so they will change.',
  };
}

/** "Based on 87 of 120 runs scored so far. The interval will change." */
export function provisionalBasis(view: ComparisonView): string {
  return `Based on ${view.progress.scored} of ${view.progress.total} runs scored so far. The interval will change.`;
}

function excludedParts(side: SensitivityView['excludedBaseline']): {
  total: number;
  parts: string;
} {
  const parts = [
    [side.executionErrors, 'execution_error'],
    [side.ungradable, 'ungradable'],
    [side.error, 'error'],
  ] as const;
  return {
    total: side.executionErrors + side.ungradable + side.error,
    parts: parts
      .filter(([n]) => n > 0)
      .map(([n, word]) => `${n} ${word}`)
      .join(', '),
  };
}

const rateLine = (kept: SensitivityView['baseline']): string =>
  `${kept.passed} / ${kept.counted} = ${formatRate(kept.rate)}`;

/**
 * The sensitivity line under the secondary metrics: the same difference without the runs
 * that broke rather than answered, with its interval, and whether the verdict depends on
 * them. Null when nothing was excluded.
 */
export function sensitivitySentence(view: ComparisonView): string | null {
  const s = view.sensitivity;
  if (!s) return null;
  const base = view.baseline.name;
  const cand = view.candidate.name;
  const b = excludedParts(s.excludedBaseline);
  const c = excludedParts(s.excludedCandidate);
  let excluded: string;
  if (b.total > 0 && c.total > 0) {
    excluded = `if the runs that broke rather than answered are excluded (${b.total} ${base}: ${b.parts}; ${c.total} ${cand}: ${c.parts}), the pass rates are ${rateLine(s.baseline)} and ${rateLine(s.candidate)}`;
  } else {
    const [name, side, kept] = b.total > 0 ? [base, b, s.baseline] : [cand, c, s.candidate];
    excluded = `if the ${side.total} ${name} run${side.total === 1 ? '' : 's'} that broke rather than answered (${side.parts}) ${side.total === 1 ? 'is' : 'are'} excluded, the ${name} pass rate is ${rateLine(kept)}`;
  }
  const difference =
    s.delta === null
      ? ''
      : ` and the difference is ${formatSigned(s.delta)}${
          s.lo !== null && s.hi !== null ? ` ${intervalText(s.lo, s.hi)}` : ''
        }`;
  let verdict = '';
  if (view.statistics) {
    if (!s.verdictChanges) verdict = ' The verdict does not depend on them.';
    else if (s.verdict === 'not_computable') {
      verdict =
        ' Without them too few runs are left for an interval, so the verdict depends on them.';
    } else verdict = ` Without them the verdict would be ${s.verdict}, so it depends on them.`;
  }
  const join = b.total > 0 && c.total > 0 ? ',' : '';
  return `Sensitivity: ${excluded}${join}${difference}.${verdict}`;
}

/** The empty state when the filter leaves no rows (ComparisonStates › Regressed 0). */
export function emptyFilterCopy(
  filter: ComparisonFilter,
  view: ComparisonView,
): { title: string; body: string } {
  const word = filter === 'all' ? '' : filter;
  return {
    title: `No ${word} tasks`.replace('  ', ' '),
    body:
      filter === 'regressed'
        ? `${view.candidate.name} did not do worse than ${view.baseline.name} on any of the ${taskCount(view)} tasks. The filter shows "Regressed 0", so this view is empty, not broken.`
        : `No task matches the ${word} filter.`,
  };
}

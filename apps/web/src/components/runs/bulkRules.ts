/**
 * What the Runs bulk bar allows for a selection, and why not (Runs board; UI_FLOWS 17 and 18):
 *   Re-score         scored runs only; refused when an llm_judge key has no judge model (the
 *                    API's 409 sentence, Phase 4 question 10) or the judge's provider is not
 *                    ready. It never re-executes.
 *   Retry execution  every selected run must be execution_error with fewer than 5 attempts,
 *                    and its configuration's provider ready.
 * Both take at most MAX_BULK_RUNS runs per request (the API refuses more with a 400).
 * The hint beside the buttons says the first thing in the way, with `code` spans as drawn.
 */
import { MAX_BULK_RUNS } from '@hermes-evals/shared';
import type { RunRow } from '@/api/types/runs';
import type { ProviderState } from './modelAccess';

/** Attempts a run may have (plan 7.3: retry from execution_error with attempt_count < 5). */
export const MAX_ATTEMPTS_PER_RUN = 5;

/** A piece of the hint: plain text, or a `code` span. */
export interface HintPart {
  text: string;
  code?: boolean;
}

export interface BulkRules {
  rescoreDisabled: boolean;
  /** The Re-score button's tooltip: its reason when disabled. */
  rescoreTitle: string;
  retryDisabled: boolean;
  retryTitle: string;
  hint: HintPart[];
  /** The hint names something the user must fix (amber). */
  blocked: boolean;
  /** The fix is Connect (a provider the UI can connect). */
  connect: boolean;
}

/** "`method` and `rationale`" as hint parts. */
function keyList(keys: string[]): HintPart[] {
  const parts: HintPart[] = [];
  keys.forEach((key, i) => {
    if (i > 0) parts.push({ text: i === keys.length - 1 ? ' and ' : ', ' });
    parts.push({ text: key, code: true });
  });
  return parts;
}

/** Splits "text `code` text" into hint parts (the API's sentences quote keys this way). */
export function hintParts(text: string): HintPart[] {
  return text
    .split('`')
    .map((t, i) => ({ text: t, code: i % 2 === 1 }))
    .filter((p) => p.text !== '');
}

export function bulkRules(
  selected: RunRow[],
  provider: (row: RunRow, side: 'judge' | 'run') => ProviderState | null,
): BulkRules {
  const scored = selected.filter((r) => r.status === 'scored');
  const errored = selected.filter((r) => r.status === 'execution_error');
  const allErrored = selected.length > 0 && errored.length === selected.length;

  // Re-score: a judge key with no model is refused whatever model access says.
  const noModel = scored.find((r) => r.needs.noJudgeModelReason !== null);
  const judgeBlocked = scored
    .map((r) => ({ row: r, state: r.needs.judgeKeys.length ? provider(r, 'judge') : null }))
    .filter((x): x is { row: RunRow; state: ProviderState } => !!x.state && !x.state.ready);
  const judgeState = judgeBlocked[0]?.state ?? null;
  const judgeKeys = [...new Set(judgeBlocked.flatMap((x) => x.row.needs.judgeKeys))];

  // Retry: every selected run must be an execution error with attempts left.
  const capped = errored.filter((r) => r.attempts >= MAX_ATTEMPTS_PER_RUN);
  const runBlocked = allErrored
    ? (errored.map((r) => provider(r, 'run')).find((s) => s !== null && !s.ready) ?? null)
    : null;

  let rescoreTitle = 'Re-runs scorers on the stored output';
  if (noModel?.needs.noJudgeModelReason) rescoreTitle = noModel.needs.noJudgeModelReason;
  else if (judgeState) {
    rescoreTitle = `Re-score needs ${judgeState.name} for the ${judgeKeys.join(' and ')} judge.`;
  } else if (scored.length === 0) {
    rescoreTitle = 'Re-score only applies to runs with status scored';
  }
  const rescoreDisabled = !!noModel || !!judgeState || scored.length === 0;

  let retryTitle = 'Retry execution only applies to runs with status execution_error';
  if (allErrored && capped.length) {
    retryTitle = `A run can have at most ${MAX_ATTEMPTS_PER_RUN} attempts`;
  } else if (runBlocked) retryTitle = `Retry needs ${runBlocked.name}.`;
  else if (allErrored) retryTitle = 'Re-executes these runs in fresh trial containers';
  const retryDisabled = !allErrored || capped.length > 0 || !!runBlocked;

  let hint: HintPart[] = [];
  if (noModel?.needs.noJudgeModelReason) {
    hint = hintParts(noModel.needs.noJudgeModelReason);
  } else if (judgeState) {
    hint = [
      { text: `Re-score needs ${judgeState.name} for the ` },
      ...keyList(judgeKeys),
      { text: ' judge.' },
    ];
    if (runBlocked) {
      hint.push({
        text:
          runBlocked.id === judgeState.id
            ? ' Retry needs it too.'
            : ` Retry needs ${runBlocked.name}.`,
      });
    }
  } else if (runBlocked) {
    hint = [{ text: `Retry needs ${runBlocked.name}.` }];
  } else if (allErrored && capped.length) {
    hint = [
      {
        text: `${capped.length} selected run(s) already have ${MAX_ATTEMPTS_PER_RUN} attempts; retry is unavailable.`,
      },
    ];
  } else if (allErrored) {
    const attempts = new Set(errored.map((r) => r.attempts));
    const only = attempts.size === 1 ? [...attempts][0] : undefined;
    hint = [
      {
        text:
          only !== undefined
            ? `Creates attempt ${only + 1} for each run.`
            : 'Creates the next attempt for each run.',
      },
    ];
  } else if (selected.length) {
    hint = [
      { text: `${selected.length - errored.length} selected run(s) are not ` },
      { text: 'execution_error', code: true },
      { text: '; retry is unavailable.' },
    ];
  }

  const blocked = !!noModel || !!judgeState || !!runBlocked;
  const connect = !noModel && (!!judgeState?.connectable || !!runBlocked?.connectable);
  if (selected.length > MAX_BULK_RUNS) {
    // One request takes at most this many: that comes before anything else.
    const title = `Select at most ${MAX_BULK_RUNS} runs`;
    return {
      rescoreDisabled: true,
      rescoreTitle: title,
      retryDisabled: true,
      retryTitle: title,
      hint: [{ text: `${title}; ${selected.length} are selected.` }],
      blocked: true,
      connect: false,
    };
  }
  return { rescoreDisabled, rescoreTitle, retryDisabled, retryTitle, hint, blocked, connect };
}

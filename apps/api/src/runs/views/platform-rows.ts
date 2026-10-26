/**
 * Timeline rows for the platform events that are not egress's connection
 * log: the worker's own (the container started, was stopped, was cancelled,
 * the workspace and the home's memories/ were collected), recovery's (`worker_lost`, `cancelled` with
 * a message), and stdout the worker could not map (`noise`, `unmapped`).
 * Payloads are read defensively, as in timeline-rows.ts.
 */
import type { TimelineEvent } from '@hermes-evals/shared';
import { blankRow, clip, count, int, str, type Payload } from './timeline-rows.js';

/** Titles and default lines of the worker's own platform events. */
const PLATFORM_ROWS: Record<string, { title: string; summary: string; error: boolean }> = {
  started: { title: 'started', summary: 'Trial container started', error: false },
  killed: { title: 'killed', summary: 'Container stopped', error: true },
  cancelled: { title: 'cancelled', summary: 'Run cancelled', error: false },
  collected: { title: 'collected', summary: 'Workspace collected', error: false },
  worker_lost: {
    title: 'worker lost',
    summary: 'The worker stopped heartbeating; recovery ended the attempt',
    error: true,
  },
};

/** The human line a platform payload carries, under whichever name its writer used. */
const messageOf = (p: Payload): string | undefined =>
  str(p, 'message') ?? str(p, 'reason') ?? str(p, 'detail');

/** Why the worker stopped a container (execution/attempt/final-events.ts `killed`). */
const KILL_REASONS: Record<string, string> = {
  deadline: 'time budget and grace reached',
  disk_limit: 'disk cap passed',
  output_limit: 'output cap passed',
  oom: 'out of memory',
};

const afterS = (p: Payload): string | undefined => {
  const ms = count(p, 'after_ms');
  return ms === undefined ? undefined : `after ${Math.round(ms / 1000)} s`;
};

const joined = (parts: ReadonlyArray<string | undefined | null | false>) =>
  parts.filter((x): x is string => typeof x === 'string' && x.length > 0).join(' · ');

/** Paths a payload lists, at most `max` of them, with the count of the rest. */
function pathList(p: Payload, key: string, total: number | undefined, max = 10): string | null {
  const v = p[key];
  if (!Array.isArray(v)) return null;
  const items = v
    .map((x: unknown) =>
      typeof x === 'string'
        ? x
        : x !== null && typeof x === 'object'
          ? str(x as Payload, 'path')
          : undefined,
    )
    .filter((x): x is string => x !== undefined);
  if (items.length === 0) return null;
  const rest = Math.max(0, (total ?? items.length) - Math.min(items.length, max));
  return `${items.slice(0, max).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/**
 * The line and detail of the worker's own events, from the fields its
 * writers put there (execution/attempt: trial-session `started`,
 * final-events `killed` and `cancelled`, collect `collected`). Recovery's
 * events carry a `message`, which wins.
 */
function workerEventDetail(
  subtype: string,
  p: Payload,
): { summary: string; text: string | null } | null {
  if (str(p, 'message')) return null;
  switch (subtype) {
    case 'started': {
      const network = str(p, 'network');
      const text = joined([
        str(p, 'image') && `image ${str(p, 'image')}`,
        network && `network ${network}`,
        str(p, 'container_id') && `container ${str(p, 'container_id')?.slice(0, 12)}`,
      ]);
      return {
        summary: network ? `Trial container started on ${network}` : 'Trial container started',
        text: text || null,
      };
    }
    case 'killed': {
      const reason = str(p, 'reason');
      if (!reason) return null;
      const label = KILL_REASONS[reason] ?? reason;
      const exit = int(p, 'exit_code');
      return {
        summary: clip(joined([`Container stopped: ${label}`, str(p, 'signal')])),
        text: joined([
          `Container stopped: ${label}`,
          str(p, 'detail'),
          str(p, 'signal'),
          exit !== undefined && `exit ${exit}`,
          afterS(p),
        ]),
      };
    }
    case 'cancelled': {
      if (p['container_started'] === false) {
        return { summary: 'Run cancelled before its container started', text: null };
      }
      const after = afterS(p);
      return {
        summary: after ? `Run cancelled · container stopped ${after}` : 'Run cancelled',
        text: null,
      };
    }
    case 'collected': {
      const files = count(p, 'files');
      if (files === undefined) return null;
      const agent = count(p, 'agent_files');
      const missed = count(p, 'not_collected_count') ?? 0;
      const deleted = count(p, 'deleted_input_count') ?? 0;
      // The home's memories/ (Phase 6 P2) is counted apart from the workspace.
      const homeFiles = count(p, 'home_files') ?? 0;
      const summary = joined([
        `${files} ${files === 1 ? 'file' : 'files'} collected`,
        agent !== undefined && `${agent} written by the agent`,
        homeFiles > 0 && `${homeFiles} memory ${homeFiles === 1 ? 'file' : 'files'}`,
        missed > 0 && `${missed} not collected`,
        deleted > 0 && `${deleted} ${deleted === 1 ? 'input' : 'inputs'} deleted`,
      ]);
      const tooLarge = pathList(p, 'too_large', undefined);
      const overBudget = pathList(p, 'over_budget', count(p, 'over_budget_count'));
      const notCollected = pathList(p, 'not_collected', missed);
      const deletedInputs = pathList(p, 'deleted_inputs', deleted);
      const homeMissed = pathList(p, 'home_not_collected', count(p, 'home_not_collected_count'));
      const deletedSeeds = pathList(p, 'deleted_home_seeds', undefined);
      const homeError = str(p, 'home_error');
      const text = [
        tooLarge && `Listed without content (too large): ${tooLarge}`,
        overBudget &&
          `Listed without content (the attempt's collection budget was used up): ${overBudget}`,
        notCollected && `Not collected: ${notCollected}`,
        deletedInputs && `Inputs the agent deleted: ${deletedInputs}`,
        homeMissed && `Not collected from the home: ${homeMissed}`,
        deletedSeeds && `Memory seeds the agent deleted: ${deletedSeeds}`,
        homeError && `The memory files could not be collected: ${homeError}`,
      ]
        .filter(Boolean)
        .join('\n');
      return { summary: clip(summary), text: text || null };
    }
    default:
      return null;
  }
}

/** A platform event other than `network`: the worker's own, or stdout it could not map. */
export function platformRow(seq: number, atMs: number, p: Payload): TimelineEvent {
  const subtype = str(p, 'subtype') ?? 'platform';
  if (subtype === 'noise') {
    const line = str(p, 'line') ?? '';
    const chars = count(p, 'chars');
    const note = p['truncated'] === true && chars ? `\n… (${chars} characters in all)` : '';
    return { ...blankRow(seq, atMs, 'platform', 'stdout', clip(line)), text: `${line}${note}` };
  }
  if (subtype === 'unmapped') {
    const json = JSON.stringify(p['event'] ?? null);
    return { ...blankRow(seq, atMs, 'platform', 'unmapped event', clip(json)), text: json };
  }
  const known = PLATFORM_ROWS[subtype];
  const detail = workerEventDetail(subtype, p);
  const message = messageOf(p);
  return {
    ...blankRow(
      seq,
      atMs,
      'platform',
      known?.title ?? subtype,
      detail?.summary ?? clip(message ?? known?.summary ?? subtype),
    ),
    error: known?.error ?? false,
    text: detail ? detail.text : (message ?? null),
  };
}

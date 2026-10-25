/**
 * How one repetition cell of the TaskGrid looks and reads (Comparison board, Components 2 ›
 * RepetitionCells): its colour follows the selected key's status once the run is scored, and
 * the run status before that, so the legend's eleven looks come from one table.
 *
 *   passed solid green · failed solid orange · error and execution_error violet with a centre
 *   dot · ungradable amber hatch · running pulsing blue outline · scoring (and executed) blue
 *   outline with a dot · queued dashed outline · cancelled neutral outline with a stroke
 *
 * The tooltip's lines and the cell's aria-label are written here too, so the grid, the
 * tooltip and the tests agree on every word.
 */
import type { ScoreStatus } from '@hermes-evals/shared';
import type { RepetitionCell } from '@/api/types/experiments';
import { formatDuration } from '@/lib/format';
import type { Tone } from '@/lib/statusTones';

export type CellLook =
  | ScoreStatus
  | 'execution_error'
  | 'running'
  | 'scoring'
  | 'executed'
  | 'queued'
  | 'cancelled'
  | 'unknown';

/** How the grid orders its rows: by Δ (the API's order) or in the suite's task order. */
export type GridSort = 'delta' | 'task';

/** A cell the grid's one tooltip should show, and the element to place it over. */
export interface CellTip {
  cell: RepetitionCell;
  taskKey: string;
  configuration: string;
  el: HTMLElement;
  via: 'hover' | 'focus';
}

/** The look of a cell: the selected key's status once scored, else its run status. */
export function cellLook(cell: RepetitionCell): CellLook {
  if (cell.runStatus === 'scored') return cell.scoreStatus ?? 'unknown';
  return cell.runStatus;
}

/** The 16px swatch per look. Written out in full so Tailwind finds every class. */
export const CELL_CLASSES: Record<CellLook, string> = {
  passed: 'bg-pass',
  failed: 'bg-fail',
  error: 'bg-[radial-gradient(circle,var(--surface)_0_2.5px,var(--err)_3px)]',
  execution_error: 'bg-[radial-gradient(circle,var(--surface)_0_2.5px,var(--err)_3px)]',
  ungradable:
    'bg-[repeating-linear-gradient(135deg,var(--ung)_0_2px,var(--ung-soft)_2px_4px)] inset-ring inset-ring-ung',
  running: 'bg-run-soft inset-ring-[1.5px] inset-ring-run animate-live',
  scoring:
    'bg-[radial-gradient(circle,var(--run)_0_2.5px,var(--run-soft)_3px)] inset-ring-[1.5px] inset-ring-run',
  executed:
    'bg-[radial-gradient(circle,var(--run)_0_2.5px,var(--run-soft)_3px)] inset-ring-[1.5px] inset-ring-run',
  queued: 'border border-dashed border-que bg-transparent',
  cancelled:
    'bg-[linear-gradient(135deg,transparent_45%,var(--que)_45%_55%,transparent_55%)] inset-ring inset-ring-que',
  unknown: 'bg-surface-3',
};

/** The tooltip chip's tone per look. */
export const CELL_TONES: Record<CellLook, Tone> = {
  passed: 'pass',
  failed: 'fail',
  error: 'err',
  execution_error: 'err',
  ungradable: 'ung',
  running: 'run',
  scoring: 'run',
  executed: 'run',
  queued: 'que',
  cancelled: 'que',
  unknown: 'que',
};

/** The word for a look: the status value itself, as stored. */
export function cellWord(look: CellLook): string {
  return look === 'unknown' ? 'scored' : look;
}

/** "attempt 1", or "attempt 2 of 2" once a run was retried (the cell is its current attempt). */
export function attemptText(attempt: number): string {
  return attempt > 1 ? `attempt ${attempt} of ${attempt}` : `attempt ${attempt}`;
}

/** The tooltip's mono line: "scored · 52 s · attempt 1", "running · attempt 1", "queued". */
export function cellMeta(cell: RepetitionCell): string {
  const duration = cell.durationS === null ? [] : [formatDuration(cell.durationS)];
  switch (cell.runStatus) {
    case 'scored':
    case 'execution_error':
      return [cell.runStatus, ...duration, attemptText(cell.attempt)].join(' · ');
    case 'running':
      return `running · ${attemptText(cell.attempt)}`;
    case 'scoring':
      return 'executed · scoring';
    case 'executed':
      return ['executed', ...duration].join(' · ');
    case 'queued':
      return 'queued';
    case 'cancelled':
      return 'cancelled';
  }
}

/** Whether the run has not finished being scored yet. */
export function isPending(cell: RepetitionCell): boolean {
  return (
    cell.runStatus === 'queued' ||
    cell.runStatus === 'running' ||
    cell.runStatus === 'executed' ||
    cell.runStatus === 'scoring'
  );
}

/** The tooltip's sentence: the primary score's comment or the execution error line. */
export function cellComment(cell: RepetitionCell): string | null {
  if (isPending(cell)) return 'Not scored yet.';
  if (cell.runStatus === 'cancelled')
    return cell.comment ?? 'Cancelled: not counted in the pass rates.';
  return cell.comment;
}

/** "dup_invoices, baseline, repetition 3, failed. Open run." */
export function cellLabel(cell: RepetitionCell, taskKey: string, configuration: string): string {
  return `${taskKey}, ${configuration}, repetition ${cell.repetition}, ${cellWord(cellLook(cell))}. Open run.`;
}

/** Runs that count toward a pass rate (scored or execution_error), and how many passed. */
export function tallyCells(cells: readonly RepetitionCell[]): { passed: number; counted: number } {
  let passed = 0;
  let counted = 0;
  for (const cell of cells) {
    if (cell.runStatus !== 'scored' && cell.runStatus !== 'execution_error') continue;
    counted += 1;
    if (cell.runStatus === 'scored' && cell.scoreStatus === 'passed') passed += 1;
  }
  return { passed, counted };
}

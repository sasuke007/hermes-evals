/**
 * The run inspector's unfenced answer (Phase 8 G5), for the `unfenced-answer` scenario:
 * dup_invoices · with-skill · rep 1 of Skill vs no skill replied with its answer as one JSON
 * object and no ```json fence. Since Phase 8 the scorer takes such a reply as the answer
 * (found, unfenced, its range the trimmed reply), where it used to be ungradable.
 */
import type { FinalResponseView } from '@/api/types/runs';

type Active = (name: string) => boolean;

/** The run the scenario changes, by its cell. */
export const UNFENCED_RUN = {
  experiment: 'skillVsNoSkill',
  task: 'dup_invoices',
  config: 'with-skill',
  repetition: 1,
} as const;

interface Cell {
  experiment: string;
  task: string;
  config: string;
  repetition: number;
}

const isUnfencedRun = (cell: Cell): boolean =>
  cell.experiment === UNFENCED_RUN.experiment &&
  cell.task === UNFENCED_RUN.task &&
  cell.config === UNFENCED_RUN.config &&
  cell.repetition === UNFENCED_RUN.repetition;

/**
 * The final response as the scenario has it: for UNFENCED_RUN under `unfenced-answer`, the
 * same parsed answer written as the whole reply, compact as a model writes it, with the line
 * break a reply ends with; every other final response as it is.
 */
export function withUnfencedAnswer(
  active: Active,
  cell: Cell,
  final: FinalResponseView | null,
): FinalResponseView | null {
  if (!final || !active('unfenced-answer') || !isUnfencedRun(cell)) return final;
  if (final.extraction !== 'found' || final.parsed === null) return final;
  const body = JSON.stringify(final.parsed);
  return {
    ...final,
    text: `${body}\n`,
    extracted: { start: 0, end: body.length },
    fence: null,
    unfenced: true,
  };
}

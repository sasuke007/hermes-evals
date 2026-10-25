/**
 * Why no run matches the Runs filters (ExperimentStates › Runs · no runs match the filters):
 * "with-skill has no execution errors in this experiment. The one execution error is on
 * baseline." Said precisely where the counts allow it, otherwise in general.
 */
import type { ConfigProgress } from '@/api/types/experiments';
import type { RunSummaryCounts } from '@/api/types/runs';
import type { HintPart } from './bulkRules';

export interface RunsFilterState {
  config: string;
  task: string;
  status: string;
  scoreStatus: string;
  execError: boolean;
  ungradable: boolean;
}

function names(list: string[]): HintPart[] {
  const parts: HintPart[] = [];
  list.forEach((name, i) => {
    if (i > 0) parts.push({ text: i === list.length - 1 ? ' and ' : ', ' });
    parts.push({ text: name, code: true });
  });
  return parts;
}

export function emptyExplanation(
  filters: RunsFilterState,
  perConfiguration: ConfigProgress[] | null,
  summary: RunSummaryCounts | null,
): HintPart[] {
  if (filters.execError && summary?.executionErrors === 0) {
    return [{ text: 'This experiment has no execution errors.' }];
  }
  if (filters.ungradable && summary?.ungradable === 0) {
    return [{ text: 'No run of this experiment is ungradable.' }];
  }
  if (filters.execError && filters.config !== 'all' && perConfiguration) {
    const own = perConfiguration.find((p) => p.configuration.name === filters.config);
    if (own && own.counts.execution_error === 0) {
      const others = perConfiguration.filter((p) => p !== own && p.counts.execution_error > 0);
      const total = others.reduce((n, p) => n + p.counts.execution_error, 0);
      const parts: HintPart[] = [
        { text: filters.config, code: true },
        { text: ' has no execution errors in this experiment.' },
      ];
      if (total > 0) {
        parts.push({
          text:
            total === 1
              ? ' The one execution error is on '
              : ` The ${total} execution errors are on `,
        });
        parts.push(...names(others.map((p) => p.configuration.name)), { text: '.' });
      }
      return parts;
    }
  }
  return [{ text: 'No run of this experiment matches all of these filters.' }];
}

/**
 * The note under "In experiments" for a task with several versions (TaskDetail board): why
 * results on different task versions do not compare, which experiment ran the version on
 * screen, or why an invalid version cannot be chosen. Pure.
 */
import type { TaskExperimentUsage } from '@/api/types/suites';

/** "the prompt", "the reference answer", … for a changed file of a task version. */
function fileWords(path: string): string {
  if (path === 'prompt.md') return 'the prompt';
  if (path === 'reference.json') return 'the reference answer';
  if (path === 'task.yaml') return 'task.yaml';
  if (path.startsWith('fixtures/')) return 'the workspace files';
  if (path.startsWith('verify/')) return 'the verifier script';
  if (path.startsWith('home/')) return 'the memory seeds';
  return path;
}

/** `a, b and c`. */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export interface ComparabilityInput {
  experiments: readonly TaskExperimentUsage[];
  /** The version on screen. */
  version: number;
  valid: boolean;
  /** Files the newest of the versions that ran changed, from the task's History. */
  changedFiles: readonly string[];
}

export function comparabilityNote(input: ComparabilityInput): string {
  const { experiments, version } = input;
  if (!input.valid) {
    return `v${version} cannot be selected in a new experiment until its self-check passes. Existing experiments keep the version they ran on.`;
  }
  if (experiments.length === 0) return 'No experiment has run this task yet.';
  const versions = [...new Set(experiments.map((e) => e.taskVersion))].sort((a, b) => a - b);
  if (versions.length === 1) {
    if (versions[0] !== version) {
      return `Every experiment so far ran on task v${versions[0]}. Results on v${versions[0]} and v${version} are not comparable.`;
    }
    return experiments.length === 1
      ? `${experiments[0]!.experimentName} ran on this version.`
      : `Every experiment so far ran on task v${version}.`;
  }
  if (versions.length === 2) {
    const words = [...new Set(input.changedFiles.map(fileWords))];
    const head = `Results on v${versions[0]} and v${versions[1]} are not comparable`;
    return words.length > 0 ? `${head}: ${listPhrase(words)} changed.` : `${head}.`;
  }
  return 'Results on different task versions are not comparable.';
}

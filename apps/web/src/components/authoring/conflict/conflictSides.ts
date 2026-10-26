/**
 * The two sides of a task both a draft and the folder on disk changed (DraftConflict board,
 * the overlap resolver): each side's text as it now reads, its lines that differ from the
 * base marked, and a one-line summary of what that side changed ("prompt +1 line · task.yaml
 * as in v6"). Pure.
 */
import type { JsonDiffEntry, TaskFileChange, TextDiffLine } from '@/api/types/suites';
import { plural } from '@/lib/format';

export interface SideLine {
  text: string;
  /** The line differs from the base version. */
  changed: boolean;
}

/** Lines of a text longer than this show only around their changes. */
const FULL_TEXT_LINES = 16;
const CONTEXT = 2;

/**
 * The side's text as it reads now (removed lines left out), each line marked when it is new;
 * a long text keeps CONTEXT lines around each change, with "…" between the stretches.
 */
export function sideText(lines: readonly TextDiffLine[]): SideLine[] {
  const now = lines.filter((l) => l.kind !== 'removed');
  const out = now.map((l) => ({ text: l.text, changed: l.kind === 'added' }));
  if (out.length <= FULL_TEXT_LINES) return out;
  const near = out.map((_, i) => out.some((l, j) => l.changed && Math.abs(i - j) <= CONTEXT));
  const kept: SideLine[] = [];
  out.forEach((line, i) => {
    if (near[i]) kept.push(line);
    else if (kept.length && kept[kept.length - 1]!.text !== '…' && near[i - 1])
      kept.push({ text: '…', changed: false });
  });
  return kept;
}

const changedLines = (lines: readonly TextDiffLine[]) => ({
  added: lines.filter((l) => l.kind === 'added').length,
  removed: lines.filter((l) => l.kind === 'removed').length,
});

function textPart(name: string, lines: readonly TextDiffLine[], base: string): string {
  const { added, removed } = changedLines(lines);
  if (added === 0 && removed === 0) return `${name} as in ${base}`;
  const parts = [
    added ? `+${plural(added, 'line')}` : '',
    removed ? `−${plural(removed, 'line')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${name} ${parts}`;
}

export interface SideInput {
  prompt: readonly TextDiffLine[];
  taskYaml: readonly TextDiffLine[];
  reference: readonly JsonDiffEntry[];
  files: readonly TaskFileChange[];
}

/** "prompt +1 line · task.yaml as in v6", then the reference and other files when they changed. */
export function sideSummary(side: SideInput, baseVersion: number): string {
  const base = `v${baseVersion}`;
  const parts = [textPart('prompt', side.prompt, base), textPart('task.yaml', side.taskYaml, base)];
  if (side.reference.length) parts.push('reference answer changed');
  const ROOT = new Set(['task.yaml', 'prompt.md', 'reference.json']);
  const files = side.files.filter((f) => !ROOT.has(f.path) && f.change !== 'unchanged');
  if (files.length) parts.push(`${plural(files.length, 'file')} changed`);
  return parts.join(' · ');
}

/**
 * The ReadinessPanel's status line and row tones (SA.8): "3 problems · 3 warnings" in violet
 * and amber, "Self-check not run since your last change", "Running self-check…", or "Ready
 * to save"; a problem row on --err-soft and a warning row on --ung-soft.
 */
import type { ReadinessStatus } from '@hermes-evals/shared';

export interface ReadinessHead {
  parts: Array<{ text: string; tone: string }>;
  /** The mark before the line. */
  icon: string;
  /** The header's fill. */
  background: string;
}

export function readinessHead(
  counts: { problems: number; warnings: number; pending: number },
  running: boolean,
): ReadinessHead {
  if (running) {
    return {
      parts: [{ text: 'Running self-check…', tone: 'text-run-text' }],
      icon: 'size-8 rounded-full bg-run animate-live',
      background: 'bg-surface',
    };
  }
  const { problems, warnings, pending } = counts;
  if (problems || warnings) {
    const parts: ReadinessHead['parts'] = [];
    if (problems)
      parts.push({
        text: `${problems} ${problems === 1 ? 'problem' : 'problems'}`,
        tone: 'text-err-text',
      });
    if (problems && warnings) parts.push({ text: '·', tone: 'text-text-3' });
    if (warnings)
      parts.push({
        text: `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
        tone: 'text-ung-text',
      });
    return {
      parts,
      icon: problems
        ? 'size-12 rounded-full border-2 border-dotted border-err'
        : 'size-10 rounded-full bg-ung',
      background: problems ? 'bg-err-soft' : 'bg-ung-soft',
    };
  }
  if (pending) {
    return {
      parts: [{ text: 'Self-check not run since your last change', tone: 'text-text-2' }],
      icon: 'size-10 rounded-full border-[1.5px] border-que',
      background: 'bg-surface',
    };
  }
  return {
    parts: [{ text: 'Ready to save', tone: 'text-pass-text' }],
    icon: 'size-10 rounded-full bg-pass',
    background: 'bg-pass-soft',
  };
}

export function rowTone(status: ReadinessStatus): { row: string; message: string } {
  if (status === 'problem') return { row: 'bg-err-soft', message: 'text-err-text' };
  if (status === 'warning') return { row: 'bg-ung-soft', message: 'text-ung-text' };
  if (status === 'passed') return { row: '', message: 'text-text-3' };
  return { row: '', message: 'text-text-2' };
}

/**
 * The readiness issues the API placed on fields (TaskReadiness.issues), looked up by the
 * field a section draws: `summary`, `maxTurns`, `checks.1.key`, a file's path. Problems win
 * over warnings; one message per field.
 */
import type { ReadinessIssue, TaskEditorSection } from '@/api/types/authoring';

export interface FieldIssue {
  message: string;
  severity: 'problem' | 'warning';
}

export function issueAt(issues: ReadinessIssue[], field: string): FieldIssue | null {
  const at = issues.filter((i) => i.target.field === field);
  const pick = at.find((i) => i.severity === 'problem') ?? at[0];
  return pick ? { message: pick.message, severity: pick.severity } : null;
}

/** Issues of a section that no field of it shows (they go at the top of the section). */
export function looseIssues(
  issues: ReadinessIssue[],
  section: TaskEditorSection,
  drawn: readonly string[],
): ReadinessIssue[] {
  return issues.filter(
    (i) =>
      i.target.section === section &&
      (i.target.field === null ||
        !drawn.some((f) => i.target.field === f || i.target.field?.startsWith(`${f}.`))),
  );
}

/** The worst mark a section carries in the index: a problem, else a warning, else none. */
export function sectionMark(
  issues: ReadinessIssue[],
  marks: Array<{ section: string; status: string }>,
  section: string,
): 'problem' | 'warning' | null {
  const all = [
    ...issues.filter((i) => i.target.section === section).map((i) => i.severity),
    ...marks
      .filter((m) => m.section === section)
      .map((m) => (m.status === 'problem' ? 'problem' : m.status === 'warning' ? 'warning' : null)),
  ];
  if (all.includes('problem')) return 'problem';
  if (all.includes('warning')) return 'warning';
  return null;
}

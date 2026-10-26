/**
 * Where a task's files are, read from the raw task.yaml so the files are
 * found (and hashed) even when another part of it is wrong: the rubrics its
 * llm_judge entries name, the expected workspace folder
 * (`self_check.expected_workspace`) and the expected home folder
 * (`self_check.expected_home`, Phase 6 P2).
 *
 * Each known-good folder must be a folder of its own inside the task: not
 * inside or around `fixtures/`, `verify/` or `home/`, whose files have their
 * own kinds, nor inside or around the other known-good folder, or a file
 * would belong to both.
 */
import { TASK_HOME_DIR, type LoadIssue } from '@hermes-evals/shared';
import { FIXTURES_DIR, VERIFY_DIR } from './limits.js';
import { normaliseRelative, type FileLayout } from './task-files.js';
import type { SuiteEntry } from './walk.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The two known-good folders, with how messages name each. */
const FOLDERS = {
  expected_workspace: 'expected workspace',
  expected_home: 'expected home',
} as const;
type FolderField = keyof typeof FOLDERS;

export function fileLayout(
  raw: Record<string, unknown>,
  byPath: ReadonlyMap<string, SuiteEntry>,
  issues: LoadIssue[],
): FileLayout {
  const rubrics: string[] = [];
  for (const entry of Array.isArray(raw.verification) ? raw.verification : []) {
    if (!isRecord(entry) || entry.type !== 'llm_judge' || !isRecord(entry.params)) continue;
    const rubric = entry.params.rubric;
    const normal = typeof rubric === 'string' ? normaliseRelative(rubric) : null;
    if (normal !== null) rubrics.push(normal);
  }

  const selfCheck = isRecord(raw.self_check) ? raw.self_check : {};
  const expectedDir = knownGoodFolder(selfCheck, 'expected_workspace', [], byPath, issues);
  const expectedHomeDir = knownGoodFolder(
    selfCheck,
    'expected_home',
    expectedDir === null ? [] : [expectedDir],
    byPath,
    issues,
  );
  return { expectedDir, expectedHomeDir, rubrics };
}

/**
 * One known-good folder as written, normalised, or null when it is absent
 * or unusable (with the issue). A missing folder or a file in its place is
 * reported and the folder still returned, so whatever is there is classified.
 */
function knownGoodFolder(
  selfCheck: Record<string, unknown>,
  field: FolderField,
  others: readonly string[],
  byPath: ReadonlyMap<string, SuiteEntry>,
  issues: LoadIssue[],
): string | null {
  const written = selfCheck[field];
  if (typeof written !== 'string') return null;
  const path = `task.yaml#self_check.${field}`;
  // The schema already refused it (an expected home under home/, say): one issue is enough.
  if (issues.some((i) => i.severity === 'error' && i.path === path)) return null;
  const what = FOLDERS[field];
  const normal = normaliseRelative(written);
  if (normal === null) {
    // '..' and absolute paths are schema issues already; '.' is not.
    if (!/(^\/|(^|\/)\.\.(\/|$))/.test(written)) {
      issues.push({
        severity: 'error',
        code: 'schema_invalid',
        path,
        message: `${field} must name a folder inside the task`,
      });
    }
    return null;
  }
  const clashes = (dir: string) =>
    normal === dir || normal.startsWith(`${dir}/`) || dir.startsWith(`${normal}/`);
  const reserved = [FIXTURES_DIR, VERIFY_DIR, TASK_HOME_DIR, ...others];
  const clash = reserved.find(clashes);
  if (clash !== undefined) {
    issues.push({
      severity: 'error',
      code: 'schema_invalid',
      path,
      message: `${field} must be a folder of its own, not inside or around ${reserved.map((d) => `${d}/`).join(', ')}`,
    });
    return null;
  }
  const entry = byPath.get(normal);
  if (!entry) {
    issues.push({
      severity: 'error',
      code: 'file_missing',
      path,
      message: `${what} folder ${normal}/ not found`,
    });
  } else if (entry.kind === 'file') {
    issues.push({
      severity: 'error',
      code: 'schema_invalid',
      path,
      message: `${what} ${normal} must be a folder`,
    });
  }
  // A link or special file there is reported by collectTaskFiles.
  return normal;
}

/**
 * Files the task editor refuses for their size (Phase 5b question 11, Phase 7): those
 * refused here, at the drop, and those the API keeps on the draft task and reports in
 * readiness, so a reload still shows them. Pure, so the store and its tests read one rule.
 */
import { AUTHORING_LIMITS, refusedUploadMessage } from '@hermes-evals/shared';
import type { DraftUploadKind, ReadinessIssue } from '@/api/types/authoring';

export interface RejectedFile {
  name: string;
  /** Where it was dropped, so the section that took the drop says so. */
  kind: DraftUploadKind;
  /** Null for a refusal the API kept, whose size it did not learn. */
  sizeBytes: number | null;
  /** "The limit is 25 MB per file.", or the API's sentence. */
  reason: string;
  /** Where it would have gone in the task folder, for a refusal the API keeps. */
  path?: string;
}

/** Why a file over AUTHORING_LIMITS.suiteMaxFileBytes is not added. */
export const OVER_LIMIT_REASON = 'The limit is 25 MB per file.';

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The kind of a kept refusal, from where its Fix goes (readiness-issues.ts) and its path. */
function kindOfRefusal(section: string, path: string): DraftUploadKind {
  if (section === 'workspace') return 'fixture';
  if (section === 'expected') return 'expected';
  return path.startsWith('home/') ? 'home_seed' : 'expected_home';
}

/**
 * The uploads the API refused for their size and keeps on the task: its file_limits
 * problems that read "`ledger-2025.parquet` is over 25 MB.", aimed at the file's path.
 */
export function keptRefusals(issues: readonly ReadinessIssue[]): RejectedFile[] {
  const limitBytes = AUTHORING_LIMITS.suiteMaxFileBytes;
  return issues.flatMap((issue) => {
    const path = issue.target.field;
    if (issue.rule !== 'file_limits' || issue.severity !== 'problem' || !path) return [];
    if (issue.message !== refusedUploadMessage({ path, limitBytes })) return [];
    return [
      {
        name: baseName(path),
        kind: kindOfRefusal(issue.target.section, path),
        sizeBytes: null,
        reason: OVER_LIMIT_REASON,
        path,
      },
    ];
  });
}

/**
 * What the drop zones list: the files refused here, then those the API keeps that are
 * neither one of them nor dismissed while a file is stored at their path.
 */
export function mergeRefusals(
  here: readonly RejectedFile[],
  kept: readonly RejectedFile[],
  dismissedPaths: readonly string[],
): RejectedFile[] {
  return [
    ...here,
    ...kept.filter(
      (k) => !dismissedPaths.includes(k.path!) && !here.some((r) => r.path === k.path),
    ),
  ];
}

/**
 * The part of a file refused here that goes to the API: its first limit + 1 bytes, so the
 * API refuses it as well (413) and keeps the refusal, while no more than that is sent.
 */
export function refusalHead(file: File): File {
  return new File([file.slice(0, AUTHORING_LIMITS.suiteMaxFileBytes + 1)], file.name, {
    type: file.type,
  });
}

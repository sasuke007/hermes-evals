/**
 * Suite list, suite detail, the version selector and the History panel
 * (UI_FLOWS 8.2), built from suites, suite_sources and tasks rows.
 *
 * Versions: the loader numbers each new suites row per directory. A reload
 * that points the directory back at an older row (reverted) creates no row,
 * so a revert is recognised by the current row not being the highest
 * number; suite_sources keeps the time and changes of the last load only.
 */
import type {
  ScorerType,
  SuiteDetail,
  SuiteHistoryEntry,
  SuiteLastLoad,
  SuiteListRow,
  SuiteLoadError,
  SuiteLoadErrorView,
  SuiteTaskRow,
  SuiteVersionOption,
  SuiteVersionRef,
  VerificationEntry,
} from '@hermes-evals/shared';
import { suiteChanges, type TaskState } from './changes.js';
import { changeSetView, emptyChangeSet, isoTime, suiteDisplayPath } from './format.js';
import type { SourceRow, SuiteRow } from './rows.js';

export function suiteRef(suite: SuiteRow): SuiteVersionRef {
  return {
    suiteId: suite.id,
    name: suite.name,
    versionNumber: suite.versionNumber,
    versionLabel: suite.versionLabel,
    contentHash: suite.contentHash,
  };
}

/** Outcomes after which the current row was (re)confirmed by the last load. */
const SERVING = new Set(['created', 'unchanged', 'reverted']);

/**
 * The stored excerpt is the lines the loader quoted around the error. Lines
 * may carry their number (`14 | text`, `> 14: text`); otherwise the line just
 * above a caret line is the error line and the lines above it count back.
 */
export function loadErrorView(error: SuiteLoadError): SuiteLoadErrorView {
  const lines = error.excerpt === null ? [] : error.excerpt.replace(/\n+$/, '').split('\n');
  const numbered = lines.map((text) => /^\s*(>)?\s*(\d+)\s*[|:] ?(.*)$/.exec(text));
  if (lines.length > 0 && numbered.every((m, i) => m || isCaret(lines[i]!))) {
    return {
      ...base(error),
      excerpt: lines.map((text, i) => {
        const m = numbered[i];
        if (!m) return { line: null, text, highlight: false };
        const line = Number(m[2]);
        return { line, text: m[3]!, highlight: Boolean(m[1]) || line === error.line };
      }),
    };
  }
  const caret = lines.findIndex(isCaret);
  return {
    ...base(error),
    excerpt: lines.map((text, i) => {
      if (caret < 0 || error.line === null || i === caret)
        return { line: null, text, highlight: false };
      if (i > caret) return { line: null, text, highlight: false };
      const line = error.line - (caret - 1 - i);
      return { line: line > 0 ? line : null, text, highlight: i === caret - 1 };
    }),
  };
}

const isCaret = (text: string): boolean => /^\s*\^+\s*$/.test(text);

const base = (e: SuiteLoadError) => ({
  file: e.file,
  line: e.line,
  column: e.column,
  message: e.message,
});

/** The directory's last load, as the list and detail show it. */
export function lastLoadView(source: SourceRow | null, current: SuiteRow | null): SuiteLastLoad {
  if (!source) {
    return {
      outcome: 'created',
      at: current ? isoTime(current.loadedAt) : new Date(0).toISOString(),
      changes: emptyChangeSet(),
      error: null,
      servedVersion: null,
    };
  }
  return {
    outcome: source.lastOutcome,
    at: isoTime(source.lastAttemptedAt),
    changes: changeSetView(source.lastChanges),
    error: source.lastError ? loadErrorView(source.lastError) : null,
    servedVersion:
      source.lastOutcome === 'error' && current
        ? {
            versionNumber: current.versionNumber,
            contentHash: current.contentHash,
            loadedAt: isoTime(current.loadedAt),
          }
        : null,
  };
}

/** Scorer types of a suite version's entries, most used first, ties alphabetical. */
export function verificationTypesByUse(
  tasks: readonly { verification: readonly VerificationEntry[] }[],
): ScorerType[] {
  const counts = new Map<ScorerType, number>();
  for (const task of tasks) {
    for (const entry of task.verification)
      counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .map(([type]) => type);
}

/**
 * One row of the suite list, for the version `suite` of its directory. The
 * load time of the current version is the last load that confirmed it.
 */
export function suiteListRow(
  suite: SuiteRow,
  source: SourceRow | null,
  tasks: readonly { verification: readonly VerificationEntry[] }[],
): SuiteListRow {
  const confirmed =
    source !== null && source.currentSuiteId === suite.id && SERVING.has(source.lastOutcome);
  return {
    ...suiteRef(suite),
    path: suiteDisplayPath(suite.sourcePath),
    description: suite.description ?? '',
    taskCount: suite.taskCount,
    validCount: suite.validCount,
    verificationTypes: verificationTypesByUse(tasks),
    loadedAt: isoTime(confirmed ? source.lastAttemptedAt : suite.loadedAt),
    lastLoad: lastLoadView(source, currentOf([suite], source)),
  };
}

const currentOf = (versions: readonly SuiteRow[], source: SourceRow | null): SuiteRow | null =>
  versions.find((v) => v.id === source?.currentSuiteId) ?? null;

const highestOf = (versions: readonly SuiteRow[]): SuiteRow | undefined =>
  versions.reduce<SuiteRow | undefined>(
    (a, b) => (!a || b.versionNumber > a.versionNumber ? b : a),
    undefined,
  );

/** True when the directory points at an older row than its newest: the last change was a revert. */
function isReverted(versions: readonly SuiteRow[], source: SourceRow | null): boolean {
  const current = currentOf(versions, source);
  return current !== null && highestOf(versions)!.versionNumber > current.versionNumber;
}

/** The version selector: the current version first, then the others newest first. */
export function versionOptions(
  versions: readonly SuiteRow[],
  source: SourceRow | null,
): SuiteVersionOption[] {
  const reverted = isReverted(versions, source);
  return [...versions]
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .sort(
      (a, b) => Number(b.id === source?.currentSuiteId) - Number(a.id === source?.currentSuiteId),
    )
    .map((v) => {
      const current = v.id === source?.currentSuiteId;
      return {
        suiteId: v.id,
        versionNumber: v.versionNumber,
        versionLabel: v.versionLabel,
        contentHash: v.contentHash,
        loadedAt: isoTime(current && reverted ? revertedAt(source!, v) : v.loadedAt),
        current,
        reverted: current && reverted,
      };
    });
}

/**
 * When the directory went back to `current`. Known only while the revert is
 * the last load; after a later load the row's own load time is shown.
 */
const revertedAt = (source: SourceRow, current: SuiteRow): Date =>
  source.lastOutcome === 'reverted' ? source.lastAttemptedAt : current.loadedAt;

export interface SuiteDetailInput {
  suite: SuiteRow;
  source: SourceRow | null;
  /** Every version of the directory. */
  versions: readonly SuiteRow[];
  /** This version's tasks, as rows of Suite detail, in suite order. */
  taskRows: readonly SuiteTaskRow[];
  /** This version's verification lists, for the type summary. */
  verification: readonly { verification: readonly VerificationEntry[] }[];
}

export function suiteDetail(input: SuiteDetailInput): SuiteDetail {
  const { suite, source, versions } = input;
  const current = source?.currentSuiteId === suite.id;
  const row = suiteListRow(suite, source, input.verification);
  const previous = versions
    .filter((v) => v.versionNumber < suite.versionNumber)
    .reduce<SuiteRow | null>((a, b) => (!a || b.versionNumber > a.versionNumber ? b : a), null);
  return {
    ...row,
    lastLoad: lastLoadView(source, currentOf(versions, source)),
    loadedAt: current ? row.loadedAt : isoTime(suite.loadedAt),
    previousContentHash: previous?.contentHash ?? null,
    tasks: [...input.taskRows],
    versions: versionOptions(versions, source),
    current,
  };
}

export interface HistoryInput {
  versions: readonly SuiteRow[];
  source: SourceRow | null;
  /** Tasks of each version, by suite id, in suite order. */
  tasksBySuite: ReadonlyMap<string, readonly TaskState[]>;
  /** Experiments launched on each version, by suite id. */
  experimentsBySuite: ReadonlyMap<string, readonly { id: string; name: string }[]>;
}

/**
 * Every version of the directory, newest first: one `created` entry per row,
 * with its changes against the version numbered before it (the loader's own
 * record for the latest load), and a `reverted` entry on top when the
 * directory went back to an older row.
 */
export function suiteHistory(input: HistoryInput): SuiteHistoryEntry[] {
  const { source } = input;
  const ascending = [...input.versions].sort((a, b) => a.versionNumber - b.versionNumber);
  const tasksOf = (s: SuiteRow) => input.tasksBySuite.get(s.id) ?? [];
  const experimentsOf = (s: SuiteRow) => [...(input.experimentsBySuite.get(s.id) ?? [])];
  const highest = ascending.at(-1);
  const entries: SuiteHistoryEntry[] = ascending.map((v, i) => {
    const previous = i > 0 ? ascending[i - 1]! : null;
    const latestCreated =
      v === highest && source?.lastOutcome === 'created' && source.currentSuiteId === v.id;
    const sameFiles = ascending
      .slice(0, i)
      .filter((p) => p.contentHash === v.contentHash)
      .at(-1);
    return {
      suiteId: v.id,
      versionNumber: v.versionNumber,
      versionLabel: v.versionLabel,
      contentHash: v.contentHash,
      loadedAt: isoTime(v.loadedAt),
      outcome: 'created',
      changes:
        latestCreated && source.lastChanges
          ? changeSetView(source.lastChanges)
          : suiteChanges(previous ? tasksOf(previous) : null, tasksOf(v)),
      sameFilesAs: sameFiles?.versionNumber ?? null,
      current: false,
      experiments: experimentsOf(v),
    };
  });
  entries.reverse();
  const current = currentOf(ascending, source);
  if (current && source && isReverted(ascending, source)) {
    entries.unshift({
      suiteId: current.id,
      versionNumber: current.versionNumber,
      versionLabel: current.versionLabel,
      contentHash: current.contentHash,
      loadedAt: isoTime(revertedAt(source, current)),
      outcome: 'reverted',
      changes:
        source.lastOutcome === 'reverted' && source.lastChanges
          ? changeSetView(source.lastChanges)
          : suiteChanges(tasksOf(highest!), tasksOf(current)),
      sameFilesAs: null,
      current: false,
      experiments: experimentsOf(current),
    });
  }
  const first = entries.find((e) => e.suiteId === source?.currentSuiteId);
  if (first) first.current = true;
  return entries;
}

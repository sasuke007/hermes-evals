/**
 * The draft world of fixtures mode: the open drafts, their tasks, and every designed state
 * of the authoring boards as a `?scenario=` (DRAFT_SCENARIOS). The world is built from the
 * suite fixtures when first read, kept in memory so the editor's autosaves stick while the
 * page is open, and built again when the active scenario changes; tests call
 * resetDraftFixtures(). The operations the data layer serves are in ./drafts-fixture-ops.ts.
 *
 * Sample: the invoices-v1 draft of SA.3 on the fixtures' current version, with overdue_count
 * added, total_due changed (one prompt sentence) and the label moved on; a new suite,
 * vendor-statements-v1, for Flow E.
 */
import type { SuiteVersionRef } from '@hermes-evals/shared';
import type {
  DraftConflict,
  DraftRefusedUpload,
  DraftSaveProgress,
  DraftSelfCheckView,
  DraftTaskState,
} from './types/authoring';
import { hasScenario, scenario } from './source';
import {
  blankContent,
  contentOfTask,
  overdueCountContent,
  overdueCountProblems,
  readTaskYaml,
  taskYamlOf,
  unmatchedLinesContent,
  fileView,
  type FixtureTaskContent,
  type YamlLock,
} from './drafts-fixture-tasks';
import {
  at,
  currentSuiteId,
  SUITE_PATH,
  suiteDetailFixture,
  suiteStateFrom,
  SUITE_V1_ID,
  SUITE_V2_ID,
  TASK_KEYS,
  taskDetailFixture,
  type SuiteState,
} from '@/fixtures/suites';

/** One task of a fixture draft. */
export interface FixtureTask extends FixtureTaskContent {
  key: string;
  position: number;
  /** removed is a state of its own; added, changed and unchanged follow from the content. */
  removed: boolean;
  base: { key: string; version: number; suiteVersion: number } | null;
  /** The base content, to tell changed from unchanged and to revert. */
  baseContent: FixtureTaskContent | null;
  restoredFrom: { taskVersion: number; suiteVersion: number } | null;
  taskYaml: string;
  lock: YamlLock | null;
  selfCheck: DraftSelfCheckView | null;
  /** Uploads refused for their size, kept until a file lands at the path or it is deleted. */
  refused?: DraftRefusedUpload[];
  revision: number;
  updatedAt: string;
}

export interface FixtureDraft {
  id: string;
  folder: string;
  name: string;
  origin: 'edit' | 'empty' | 'copy' | 'zip';
  base: SuiteVersionRef | null;
  baseLabel: string | null;
  versionLabel: string;
  baseDescription: string | null;
  description: string | null;
  baseOrder: string[];
  tasks: FixtureTask[];
  conflict: DraftConflict | null;
  saving: DraftSaveProgress | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export const NEW_SUITE_FOLDER = 'vendor-statements-v1';
const SAVED_AT = at(23, '16:31:00');

/** The time of a fixture write: the real clock, so "saved 16:31" moves as you type. */
export const nowIso = (): string => new Date().toISOString();

const snapshot = (c: FixtureTaskContent): string =>
  JSON.stringify([
    c.form,
    c.prompt,
    c.reference,
    c.rubrics,
    c.files.map((f) => [f.path, f.sha256]),
  ]);

/** The state a task shows: removed, restored, added (new or renamed), changed or unchanged. */
export function stateOf(task: FixtureTask): DraftTaskState {
  if (task.removed) return 'removed';
  if (task.restoredFrom) return 'restored';
  if (!task.base || task.base.key !== task.key) return 'added';
  if (task.lock) return 'changed';
  return task.baseContent && snapshot(task) === snapshot(task.baseContent)
    ? 'unchanged'
    : 'changed';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function makeTask(
  key: string,
  content: FixtureTaskContent,
  base: FixtureTask['base'],
  baseContent: FixtureTaskContent | null,
): FixtureTask {
  return {
    ...clone(content),
    key,
    position: 0,
    removed: false,
    base,
    baseContent: baseContent ? clone(baseContent) : null,
    restoredFrom: null,
    taskYaml: taskYamlOf(content.form),
    lock: null,
    selfCheck: null,
    revision: 1,
    updatedAt: SAVED_AT,
  };
}

/** The suite state of the suite fixtures this draft world sits on. */
export function suiteState(): SuiteState {
  // A conflict needs a v2 on disk: late_fees changed (no overlap), or total_due (overlap).
  if (hasScenario('draft-restored') || hasScenario('draft-conflict-overlap'))
    return 'newer-version';
  if (hasScenario('draft-conflict')) return 'invalid-task';
  return suiteStateFrom(hasScenario);
}

const inConflict = (): boolean =>
  hasScenario('draft-conflict') || hasScenario('draft-conflict-overlap');

/** A base task of the suite fixtures, at the version the draft is based on. */
export function baseTask(state: SuiteState, suiteId: string, key: string): FixtureTask | null {
  const detail = taskDetailFixture(state, suiteId, key);
  if (!detail) return null;
  const content = contentOfTask(detail);
  const base = { key, version: detail.version, suiteVersion: detail.suite.versionNumber };
  return makeTask(key, content, base, content);
}

function invoicesDraft(): FixtureDraft {
  const state = suiteState();
  // In a conflict the draft began on v1 and the folder moved on to v2.
  const baseId = inConflict() ? SUITE_V1_ID : currentSuiteId(state);
  const detail = suiteDetailFixture(state, baseId)!;
  const baseRef: SuiteVersionRef = {
    suiteId: detail.suiteId,
    name: detail.name,
    versionNumber: detail.versionNumber,
    versionLabel: detail.versionLabel,
    contentHash: detail.contentHash,
  };
  const tasks = TASK_KEYS.map((key) => baseTask(state, baseId, key)!);
  const added = makeTask(
    'overdue_count',
    hasScenario('task-problems') ? overdueCountProblems() : overdueCountContent(),
    null,
    null,
  );
  tasks.splice(TASK_KEYS.indexOf('overdue_list') + 1, 0, added);
  const totalDue = tasks.find((t) => t.key === 'total_due')!;
  totalDue.prompt = (totalDue.prompt ?? '').replace(
    'including `disputed` ones.\n',
    'including `disputed` ones.\n\nCredit notes have negative amounts and reduce the total.\n',
  );
  if (hasScenario('task-problems')) {
    const leak = `Reminder for the team: the open total was ${JSON.stringify(totalDue.baseContent?.reference ?? '').match(/[\d.]+/)?.[0] ?? ''} last month.\n`;
    totalDue.files.push(fileView('fixtures/notes.txt', 'fixture', leak.length, 'Text · 3 lines'));
    totalDue.texts['fixtures/notes.txt'] = leak;
  }
  if (hasScenario('task-large-text')) {
    // A rubric a zip held at more than an editor holds: an `other` blob, read-only (V5).
    const big = fileView('rubrics/method.md', 'other', 1_468_006, 'Text · 18,204 lines');
    added.files.push({ ...big, tooLargeToEdit: true });
  }
  if (hasScenario('task-yaml-error')) {
    added.taskYaml = added.taskYaml.replace('    primary: true', '    prmary: true');
    const read = readTaskYaml(added.taskYaml, added.form);
    added.lock = read.lock;
  }
  if (hasScenario('draft-restored')) {
    const v1 = baseTask(state, 'suite_01JAT3F9C2A1', 'total_due');
    if (v1)
      Object.assign(totalDue, {
        ...clone(v1),
        base: totalDue.base,
        baseContent: totalDue.baseContent,
        restoredFrom: { taskVersion: 1, suiteVersion: 1 },
      });
  }
  if (hasScenario('draft-removed')) tasks.find((t) => t.key === 'currency_mix')!.removed = true;
  tasks.forEach((t, i) => (t.position = i));
  const draft: FixtureDraft = {
    id: 'draft_01JBG4QK7Z',
    folder: detail.name,
    name: detail.name,
    origin: 'edit',
    base: baseRef,
    baseLabel: detail.versionLabel,
    versionLabel: hasScenario('draft-label-empty') ? '' : bumpLabel(detail.versionLabel),
    baseDescription: detail.description,
    description: detail.description,
    baseOrder: [...TASK_KEYS],
    tasks,
    conflict: null,
    saving: null,
    revision: 7,
    createdAt: at(23, '16:12:40'),
    updatedAt: SAVED_AT,
  };
  if (inConflict())
    draft.conflict = conflictOf(state, baseRef, hasScenario('draft-conflict-overlap'));
  if (hasScenario('draft-saving')) {
    draft.saving = { startedAt: SAVED_AT, step: 'self_checks', selfChecks: { done: 1, total: 2 } };
  }
  return draft;
}

/** "0.1" → "0.2": the label the sample draft moved on to. */
function bumpLabel(label: string | null): string {
  const match = /^(.*?)(\d+)$/.exec(label ?? '');
  return match ? `${match[1]}${Number(match[2]) + 1}` : '0.2';
}

/** SA.12: a reload created v2 of the suite fixtures after the draft began on v1. */
function conflictOf(state: SuiteState, base: SuiteVersionRef, overlap: boolean): DraftConflict {
  const v2 = suiteDetailFixture(state, SUITE_V2_ID)!;
  const changed = overlap ? ['total_due'] : ['late_fees'];
  return {
    cause: 'version_moved',
    baseVersion: base.versionNumber,
    current: {
      suiteId: v2.suiteId,
      name: v2.name,
      versionNumber: v2.versionNumber,
      versionLabel: v2.versionLabel,
      contentHash: v2.contentHash,
      loadedAt: v2.loadedAt,
    },
    diskChanges: {
      added: [],
      removed: [],
      changed,
      nowInvalid: overlap ? [] : ['late_fees'],
      nowValid: [],
    },
    draftKeys: ['overdue_count', 'total_due'],
    overlap: overlap ? ['total_due'] : [],
  };
}

function newSuiteDraft(): FixtureDraft {
  const tasks: FixtureTask[] = [];
  if (hasScenario('task-flowe'))
    tasks.push(makeTask('unmatched_lines', unmatchedLinesContent(), null, null));
  return {
    id: 'draft_01JBG9VS2M',
    folder: NEW_SUITE_FOLDER,
    name: NEW_SUITE_FOLDER,
    origin: 'empty',
    base: null,
    baseLabel: null,
    versionLabel: '0.1',
    baseDescription: null,
    description: 'Reconciling vendor statements against the ledger.',
    baseOrder: [],
    tasks,
    conflict: null,
    saving: null,
    revision: tasks.length + 1,
    createdAt: at(23, '16:05:00'),
    updatedAt: at(23, '16:05:00'),
  };
}

let world: Map<string, FixtureDraft> | null = null;
let builtFor: string | null | undefined;

/** The drafts of the active scenario, built on first use. */
export function draftWorld(): Map<string, FixtureDraft> {
  const active = scenario();
  if (world && builtFor === active) return world;
  world = new Map();
  builtFor = active;
  if (!hasScenario('empty') && !hasScenario('draft-none')) {
    const invoices = invoicesDraft();
    world.set(invoices.folder, invoices);
  }
  if (hasScenario('draft-new-suite') || hasScenario('task-flowe')) {
    const fresh = newSuiteDraft();
    world.set(fresh.folder, fresh);
  }
  return world;
}

/** Forget every edit: the next read builds the world again (tests call this first). */
export function resetDraftFixtures(): void {
  world = null;
  builtFor = undefined;
}

export { blankContent, SUITE_PATH };

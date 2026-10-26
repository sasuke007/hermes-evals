/**
 * Drafts as a whole in fixtures mode: listing, opening, creating and discarding them, the
 * task diff against the base, Review and save (SA.11), and combining onto a newer version
 * (SA.12). Saving deletes the draft, as the API does once the folder is written and loaded.
 */
import type {
  CreateSuiteDraftRequest,
  DraftConflictBody,
  DraftSaveResult,
  DraftSummary,
  DraftTaskDiff,
  RebaseSuiteDraftRequest,
  SaveSuiteDraftRequest,
  SuiteDraftView,
} from './types/authoring';
import type { TextDiffLine } from './types/suites';
import { ApiError } from './client';
import { hasScenario } from './source';
import { findDraft } from './drafts-fixture-ops';
import { review } from './drafts-fixture-review';
import { taskYamlOf } from './drafts-fixture-tasks';
import { draftSummary, draftView, touch } from './drafts-fixture-views';
import { baseTask, draftWorld, nowIso, suiteState, type FixtureDraft } from './drafts-fixtures';
import { currentSuiteId, sha, SUITE_NAME, suiteDetailFixture, TASK_KEYS } from '@/fixtures/suites';

export { review };

const path = (folder: string) => `/api/suites/${folder}/draft`;

export function listDrafts(): DraftSummary[] {
  return [...draftWorld().values()].map(draftSummary);
}

export function getDraft(folder: string): SuiteDraftView {
  return draftView(findDraft(folder, `GET ${path(folder)}`));
}

/** POST /suites/:suite/draft: the open draft, or a new one on the current version. */
export function openDraft(folder: string): SuiteDraftView {
  const world = draftWorld();
  const open = world.get(folder);
  if (open) return draftView(open);
  const state = suiteState();
  const detail = folder === SUITE_NAME ? suiteDetailFixture(state, currentSuiteId(state)) : null;
  if (!detail) throw new ApiError(404, `POST ${path(folder)}`, `suite ${folder} not found`);
  const tasks = TASK_KEYS.map((key, i) => ({
    ...baseTask(state, detail.suiteId, key)!,
    position: i,
  }));
  const now = nowIso();
  const draft: FixtureDraft = {
    id: `draft_${sha(now).slice(0, 10).toUpperCase()}`,
    folder,
    name: folder,
    origin: 'edit',
    base: {
      suiteId: detail.suiteId,
      name: detail.name,
      versionNumber: detail.versionNumber,
      versionLabel: detail.versionLabel,
      contentHash: detail.contentHash,
    },
    baseLabel: detail.versionLabel,
    versionLabel: detail.versionLabel ?? '',
    baseDescription: detail.description,
    description: detail.description,
    baseOrder: [...TASK_KEYS],
    tasks,
    conflict: null,
    saving: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  world.set(folder, draft);
  return draftView(draft);
}

/** POST /suites/drafts: a new suite (SA.2); a copy takes every task of invoices-v1. */
export function createDraft(body: CreateSuiteDraftRequest): SuiteDraftView {
  const request = 'POST /api/suites/drafts';
  const world = draftWorld();
  if (body.name === SUITE_NAME && !hasScenario('empty')) {
    throw new ApiError(409, request, `${body.name} is already used by ./suites/${body.name}.`);
  }
  if (world.has(body.name)) throw new ApiError(409, request, `${body.name} already has a draft.`);
  const now = nowIso();
  const state = suiteState();
  const tasks =
    body.from.kind === 'copy'
      ? TASK_KEYS.map((key, i) => {
          const task = baseTask(state, currentSuiteId(state), key)!;
          return { ...task, base: null, baseContent: null, position: i };
        })
      : [];
  const draft: FixtureDraft = {
    id: `draft_${sha(body.name).slice(0, 10).toUpperCase()}`,
    folder: body.name,
    name: body.name,
    origin: body.from.kind,
    base: null,
    baseLabel: null,
    versionLabel: body.versionLabel,
    baseDescription: null,
    description: body.description ?? null,
    baseOrder: [],
    tasks,
    conflict: null,
    saving: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  world.set(draft.folder, draft);
  return draftView(draft);
}

export function discardDraft(folder: string): void {
  findDraft(folder, `DELETE ${path(folder)}`);
  draftWorld().delete(folder);
}

/** A line diff by longest common subsequence: enough for prompts and task.yaml files. */
export function lineDiff(before: string, after: string): TextDiffLine[] {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: TextDiffLine[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push({ kind: 'added', text: b[j]!, oldLine: null, newLine: j + 1 });
      j++;
    } else {
      out.push({ kind: 'removed', text: a[i]!, oldLine: i + 1, newLine: null });
      i++;
    }
  }
  return out;
}

export function taskDiff(folder: string, key: string): DraftTaskDiff {
  const request = `GET ${path(folder)}/tasks/${key}/diff`;
  const draft = findDraft(folder, request);
  const task = draft.tasks.find((t) => t.key === key);
  if (!task) throw new ApiError(404, request, `task ${key} is not in the draft`);
  const base = task.baseContent;
  const files = task.files.map((f) => {
    const old = base?.files.find((b) => b.path === f.path) ?? null;
    const change = !old ? 'added' : old.sha256 === f.sha256 ? 'unchanged' : 'changed';
    return {
      path: f.path,
      change,
      before: old ? { sizeBytes: old.sizeBytes, sha256: old.sha256 } : null,
      after: { sizeBytes: f.sizeBytes, sha256: f.sha256 },
    } as const;
  });
  return {
    key,
    from:
      task.base && draft.base
        ? {
            suiteId: draft.base.suiteId,
            suiteVersion: task.base.suiteVersion,
            taskVersion: task.base.version,
          }
        : null,
    updatedAt: task.updatedAt,
    prompt: lineDiff(base?.prompt ?? '', task.prompt ?? ''),
    taskYaml: lineDiff(base ? taskYamlOf(base.form) : '', task.taskYaml),
    reference: [],
    referenceText: lineDiff(base?.reference ?? '', task.reference ?? ''),
    files: [...files],
    textFiles: [],
  };
}

/** POST …/draft/save: the next version, or the conflict that stops it (SA.11, SA.12). */
export function save(
  folder: string,
  body: SaveSuiteDraftRequest,
): { ok: true; result: DraftSaveResult } | { ok: false; conflict: DraftConflictBody } {
  const request = `POST ${path(folder)}/save`;
  const draft = findDraft(folder, request);
  if (hasScenario('no-worker'))
    throw new ApiError(503, request, 'Saving needs the worker. Your draft is kept.');
  if (draft.conflict) {
    return {
      ok: false,
      conflict: {
        statusCode: 409,
        message: `./suites/${folder} changed on disk after this draft began`,
        conflict: structuredClone(draft.conflict),
      },
    };
  }
  const view = draftView(draft);
  const kept = draft.tasks.filter((t) => !t.removed);
  const invalid = review(folder).invalid;
  const versionNumber = view.nextVersion;
  draftWorld().delete(folder);
  return {
    ok: true,
    result: {
      outcome: view.changes.length === 0 ? 'unchanged' : 'created',
      suite: {
        suiteId: `suite_${sha(`${folder}-v${versionNumber}`).slice(0, 12).toUpperCase()}`,
        name: draft.name,
        versionNumber:
          view.changes.length === 0 && draft.base ? draft.base.versionNumber : versionNumber,
        versionLabel: body.versionLabel ?? draft.versionLabel,
        contentHash: sha(`${folder}-v${versionNumber}`),
      },
      changes: {
        added: view.changes.flatMap((c) => (c.kind === 'added' ? [c.key] : [])),
        removed: view.changes.flatMap((c) => (c.kind === 'removed' ? [c.key] : [])),
        changed: view.changes.flatMap((c) =>
          c.kind === 'changed' || c.kind === 'restored' ? [c.key] : [],
        ),
        nowInvalid: invalid.map((i) => i.key),
        nowValid: [],
      },
      taskCount: kept.length,
      validCount: kept.length - invalid.length,
      invalid,
    },
  };
}

/** POST …/draft/rebase: the draft moves onto the newer version, one side kept per overlap. */
export function rebase(folder: string, body: RebaseSuiteDraftRequest): SuiteDraftView {
  const request = `POST ${path(folder)}/rebase`;
  const draft = findDraft(folder, request);
  if (!draft.conflict)
    throw new ApiError(409, request, 'the draft is already on the current version');
  const current = draft.conflict.current;
  for (const choice of body.choices) {
    const task = draft.tasks.find((t) => t.key === choice.key);
    if (task && choice.keep === 'disk' && task.baseContent)
      Object.assign(task, structuredClone(task.baseContent));
  }
  draft.base = {
    suiteId: current.suiteId,
    name: current.name,
    versionNumber: current.versionNumber,
    versionLabel: current.versionLabel,
    contentHash: current.contentHash,
  };
  draft.conflict = null;
  touch(draft);
  return draftView(draft);
}

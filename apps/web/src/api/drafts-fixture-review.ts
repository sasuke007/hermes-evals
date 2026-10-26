/**
 * Review and save in fixtures mode (SA.11): each change in one line ("new task · 4 files ·
 * 1 check", "prompt +1 sentence", "label 0.3 → 0.4"), what Save writes, and the readiness of
 * the changed tasks ("added · self-check passed · 16:31", "changed · reference passes
 * `answer`"), with the tasks that would be stored invalid.
 */
import { refusedUploadMessage } from '@hermes-evals/shared';
import type { DraftChange, DraftReview, DraftTaskDetail, DraftWrite } from './types/authoring';
import { findDraft } from './drafts-fixture-ops';
import { draftView, taskDetailView, taskRowView } from './drafts-fixture-views';
import { stateOf, type FixtureDraft, type FixtureTask } from './drafts-fixtures';
import { plural } from '@/lib/format';

const bytes = (text: string | null): number | null =>
  text === null ? null : new TextEncoder().encode(text).length;
const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** "prompt +1 sentence · checks changed": what a changed task changed. */
function changedParts(task: FixtureTask): string {
  const base = task.baseContent;
  if (!base) return '';
  const parts: string[] = [];
  if (task.prompt !== base.prompt) {
    const before = new Set((base.prompt ?? '').split('\n'));
    const added = (task.prompt ?? '')
      .split('\n')
      .filter((l) => l.trim() !== '' && !before.has(l)).length;
    parts.push(added > 0 ? `prompt +${plural(added, 'sentence')}` : 'prompt edited');
  }
  if (JSON.stringify(task.form.checks) !== JSON.stringify(base.form.checks))
    parts.push('checks changed');
  else if (JSON.stringify(task.form) !== JSON.stringify(base.form)) parts.push('task.yaml changed');
  if (task.reference !== base.reference) parts.push('reference changed');
  const files = (f: FixtureTask['files']) => f.map((x) => `${x.path}:${x.sha256}`).join();
  if (files(task.files) !== files(base.files)) parts.push('files changed');
  return parts.join(' · ');
}

function detailOf(draft: FixtureDraft, change: DraftChange): string {
  const task = 'key' in change ? draft.tasks.find((t) => t.key === change.key) : undefined;
  switch (change.kind) {
    case 'added':
      return task
        ? `new task · ${plural(task.files.length + 3, 'file')} · ${plural(task.form.checks.length, 'check')}`
        : 'new task';
    case 'changed':
      return task ? changedParts(task) : '';
    case 'removed':
      return task ? `removes ${plural(task.files.length + 3, 'file')}` : '';
    case 'restored':
      return `the files of v${change.fromTaskVersion} again`;
    case 'label':
      return `label ${change.from ?? '—'} → ${change.to}`;
    case 'description':
      return 'description edited';
    case 'order':
      return 'task order in suite.yaml';
  }
}

/** True when every file-limits problem of the task is an upload refused for its size. */
function onlyRefused(task: FixtureTask, detail: DraftTaskDetail): boolean {
  const refused = new Set((task.refused ?? []).map(refusedUploadMessage));
  return detail.readiness.issues
    .filter((i) => i.rule === 'file_limits' && i.severity === 'problem')
    .every((i) => refused.has(i.message));
}

/** "self-check passed · 16:31", "reference passes `answer`", or the first problem. */
function readinessNote(draft: FixtureDraft, task: FixtureTask): string {
  const detail = taskDetailView(draft, task);
  const run = task.selfCheck;
  if (run?.current)
    return run.status === 'passed' ? `self-check passed · ${hhmm(run.ranAt)}` : 'self-check failed';
  const problem = detail.readiness.rules.find((r) => r.status === 'problem');
  if (problem) return problem.message;
  if (detail.readiness.needsWorker) return 'self-check not run';
  const primary = task.form.checks.find((c) => c.primary);
  return primary ? `reference passes \`${primary.key}\`` : 'ready';
}

export function review(folder: string): DraftReview {
  const draft = findDraft(folder, `GET /api/suites/${folder}/draft/review`);
  const view = draftView(draft);
  const root = `./suites/${folder}`;
  const writes: DraftWrite[] = [];
  const readiness: DraftReview['readiness'] = [];
  const invalid: DraftReview['invalid'] = [];
  for (const task of draft.tasks) {
    const state = stateOf(task);
    if (state === 'unchanged') continue;
    const dir = `${root}/${task.key}`;
    if (state === 'removed') {
      writes.push({
        op: 'remove',
        path: `${dir}/`,
        beforeBytes: null,
        afterBytes: null,
        note: plural(task.files.length + 3, 'file'),
      });
      continue;
    }
    const base = state === 'added' ? null : task.baseContent;
    const texts: Array<[string, string | null, string | null]> = [
      ['prompt.md', base?.prompt ?? null, task.prompt],
      ['task.yaml', null, task.taskYaml],
      ['reference.json', base?.reference ?? null, task.reference],
    ];
    for (const [name, before, after] of texts) {
      if (base && name === 'task.yaml' && JSON.stringify(task.form) === JSON.stringify(base.form))
        continue;
      if (base && name !== 'task.yaml' && before === after) continue;
      writes.push({
        op: base ? 'change' : 'add',
        path: `${dir}/${name}`,
        beforeBytes: base ? bytes(before) : null,
        afterBytes: bytes(after),
        note: null,
      });
    }
    for (const file of task.files.filter((f) => f.kind !== 'verifier')) {
      const old = base?.files.find((f) => f.path === file.path);
      if (old && old.sha256 === file.sha256) continue;
      writes.push({
        op: old ? 'change' : 'add',
        path: `${dir}/${file.path}`,
        beforeBytes: old?.sizeBytes ?? null,
        afterBytes: file.sizeBytes,
        note: null,
      });
    }
    readiness.push({
      key: task.key,
      state,
      readiness: taskRowView(draft, task).readiness,
      note: `${state} · ${readinessNote(draft, task)}`,
    });
    const detail = taskDetailView(draft, task);
    // An upload refused for its size leaves no file behind: alone, it does not make the task
    // load invalid (Phase 5b #11), as the API's draft-review.ts decides.
    const problems = detail.readiness.rules.filter(
      (r) => r.status === 'problem' && !(r.rule === 'file_limits' && onlyRefused(task, detail)),
    );
    if (problems.length > 0) {
      const selfCheck = problems.find((r) => r.rule === 'self_check');
      const first = problems[0];
      invalid.push({
        key: task.key,
        reason: selfCheck ? 'self-check failed' : (first?.message ?? 'has problems'),
      });
    }
  }
  const notes: string[] = [];
  const label = view.changes.find((c) => c.kind === 'label');
  if (label?.kind === 'label') notes.push(`version_label ${label.from ?? '—'} → ${label.to}`);
  const added = view.changes.flatMap((c) => (c.kind === 'added' ? [c.key] : []));
  const removed = view.changes.flatMap((c) => (c.kind === 'removed' ? [c.key] : []));
  if (added.length) notes.push(`tasks + ${added.join(', ')}`);
  if (removed.length) notes.push(`tasks − ${removed.join(', ')}`);
  if (notes.length || view.changes.some((c) => c.kind === 'order' || c.kind === 'description')) {
    writes.push({
      op: draft.base ? 'change' : 'add',
      path: `${root}/suite.yaml`,
      beforeBytes: null,
      afterBytes: null,
      note: notes.join(' · ') || null,
    });
  }
  const changes = view.changes.map((change) => ({ change, detail: detailOf(draft, change) }));
  return { draft: view, changes, writes, readiness, invalid };
}

/**
 * The draft task open in the task editor (SA.4 to SA.8): the API's picture of it, and the
 * copies the Form, Files and task.yaml tabs edit. Every change saves itself: the editor
 * shows it at once, and after a short pause (TASK_DEBOUNCE_MS) one PUT carries what changed,
 * with the revision it was made on. Writes go one at a time; what is typed meanwhile waits
 * for the next. The answer replaces each copy nobody has edited since, so task.yaml follows
 * a form edit and the form follows a task.yaml edit (or locks while task.yaml has an error),
 * and readiness is the API's for what was saved.
 *
 * The form and task.yaml are never sent together (UpdateDraftTaskRequest): when both wait,
 * the form goes first. A rename is sent only when the key is a folder name no other task
 * holds; until then the key field says why. The editor's save line reads "saving…" while a
 * write waits or runs, "saved 16:31" after, and a failed write keeps the edit with Try again
 * (copy no board draws; SA.4 draws only "draft · saved 16:31").
 */
import { DIRECTORY_KEY_MESSAGE, DIRECTORY_KEY_PATTERN } from '@hermes-evals/shared';
import { defineStore } from 'pinia';
import { computed, ref, toRaw } from 'vue';
import { errorMessage, isApiError } from '@/api/client';
import { getDraftTask, revertDraftTask, updateDraftTask } from '@/api/drafts';
import type { DraftTaskDetail, TaskForm, UpdateDraftTaskRequest } from '@/api/types/authoring';
import { useDraftStore } from './draft';

/** Pause after the last change before the task is written. */
export const TASK_DEBOUNCE_MS = 400;

export type TaskSaveStatus = 'saved' | 'saving' | 'failed';

interface Pending {
  form?: TaskForm;
  taskYaml?: string;
  prompt?: string;
  reference?: string;
  rubrics?: Record<string, string>;
  key?: string;
}

export const useDraftTaskStore = defineStore('draftTask', () => {
  const draftStore = useDraftStore();

  const folder = ref<string | null>(null);
  /** The key the API knows the task by (it moves after a rename is stored). */
  const key = ref<string | null>(null);
  const detail = ref<DraftTaskDetail | null>(null);
  const loadError = ref<string | null>(null);

  const form = ref<TaskForm | null>(null);
  const taskYaml = ref('');
  const prompt = ref('');
  const reference = ref('');
  const rubrics = ref<Record<string, string>>({});
  const keyDraft = ref('');

  const status = ref<TaskSaveStatus>('saved');
  const saveError = ref<string | null>(null);
  /** Goes up after every stored write; Try it on the reference follows it. */
  const savedTick = ref(0);

  let pending: Pending = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  /** Why the key field cannot be stored, or null. */
  const keyProblem = computed<string | null>(() => {
    const value = keyDraft.value;
    if (!DIRECTORY_KEY_PATTERN.test(value)) return DIRECTORY_KEY_MESSAGE;
    const view = folder.value ? draftStore.drafts[folder.value] : undefined;
    if (value !== key.value && view?.tasks.some((t) => t.key === value)) {
      return `\`${value}\` is already a task in \`${view.name}\`.`;
    }
    return null;
  });

  /** The form is read-only while task.yaml has an error (SA.6). */
  const locked = computed(() => detail.value?.formLock != null);

  function take(next: DraftTaskDetail, sent: Pending | null): void {
    detail.value = next;
    key.value = next.key;
    if (!('form' in pending) && !('taskYaml' in pending)) form.value = structuredClone(next.form);
    if (!('taskYaml' in pending)) taskYaml.value = next.taskYaml ?? '';
    if (!('prompt' in pending)) prompt.value = next.prompt ?? '';
    if (!('reference' in pending)) reference.value = next.reference ?? '';
    if (!('rubrics' in pending))
      rubrics.value = Object.fromEntries(next.rubrics.map((r) => [r.path, r.text]));
    // A key that cannot be stored stays as typed, with its message.
    if (!('key' in pending) && (sent === null || keyProblem.value === null))
      keyDraft.value = next.key;
  }

  function reset(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = {};
    detail.value = null;
    loadError.value = null;
    status.value = 'saved';
    saveError.value = null;
  }

  /** Opens a task of a draft (the editor's route). */
  async function open(nextFolder: string, nextKey: string): Promise<void> {
    if (folder.value === nextFolder && key.value === nextKey && detail.value) {
      await reload();
      return;
    }
    reset();
    folder.value = nextFolder;
    key.value = nextKey;
    await reload();
  }

  async function reload(): Promise<void> {
    const f = folder.value;
    const k = key.value;
    if (!f || !k) return;
    try {
      const next = await getDraftTask(f, k);
      if (folder.value !== f || key.value !== k) return;
      loadError.value = null;
      take(next, null);
    } catch (err) {
      loadError.value = errorMessage(err);
    }
  }

  function schedule(): void {
    status.value = 'saving';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), TASK_DEBOUNCE_MS);
  }

  /** A form edit: `change` mutates a copy of the form. */
  function editForm(change: (draft: TaskForm) => void): void {
    if (!form.value || locked.value) return;
    const next = structuredClone(toRaw(form.value));
    change(next);
    form.value = next;
    pending.form = next;
    schedule();
  }

  function editYaml(text: string): void {
    taskYaml.value = text;
    pending.taskYaml = text;
    schedule();
  }

  function editPrompt(text: string): void {
    prompt.value = text;
    pending.prompt = text;
    schedule();
  }

  function editReference(text: string): void {
    reference.value = text;
    pending.reference = text;
    schedule();
  }

  function editRubric(path: string, text: string): void {
    rubrics.value = { ...rubrics.value, [path]: text };
    pending.rubrics = { ...pending.rubrics, [path]: text };
    schedule();
  }

  /** The key field: shown at once, stored once it is a free folder name. */
  function editKey(text: string): void {
    keyDraft.value = text;
    if (keyProblem.value === null && text !== key.value) {
      pending.key = text;
      schedule();
    } else {
      delete pending.key;
      if (Object.keys(pending).length === 0 && !running)
        status.value = saveError.value ? 'failed' : 'saved';
    }
  }

  /** What one write carries: the form or task.yaml, never both. */
  function nextBody(): [UpdateDraftTaskRequest, Pending] {
    const sent: Pending = { ...pending };
    if (sent.form && sent.taskYaml !== undefined) delete sent.taskYaml;
    for (const part of Object.keys(sent) as Array<keyof Pending>) delete pending[part];
    const body: UpdateDraftTaskRequest = {};
    if (sent.key !== undefined) body.key = sent.key;
    if (sent.form) body.form = sent.form;
    if (sent.taskYaml !== undefined) body.taskYaml = sent.taskYaml;
    if (sent.prompt !== undefined) body.prompt = sent.prompt;
    if (sent.reference !== undefined) body.reference = sent.reference;
    if (sent.rubrics)
      body.rubrics = Object.entries(sent.rubrics).map(([path, text]) => ({ path, text }));
    if (detail.value) body.revision = detail.value.revision;
    return [body, sent];
  }

  async function write(): Promise<void> {
    const f = folder.value;
    const k = key.value;
    if (!f || !k || Object.keys(pending).length === 0) return;
    const [body, sent] = nextBody();
    try {
      const next = await updateDraftTask(f, k, body);
      saveError.value = null;
      take(next, sent);
      savedTick.value++;
      if (sent.key !== undefined) void draftStore.load(f).catch(() => undefined);
    } catch (err) {
      // The edit is kept: what failed waits again, under anything typed since.
      pending = { ...sent, ...pending };
      saveError.value = errorMessage(err);
      if (isApiError(err) && err.status === 409) {
        const fresh = await getDraftTask(f, k).catch(() => null);
        if (fresh) detail.value = fresh;
      }
    }
  }

  /** Sends every waiting change now; resolves when nothing is waiting or a write failed. */
  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    while (running) await running;
    while (Object.keys(pending).length > 0) {
      running = write();
      await running;
      running = null;
      if (saveError.value) break;
    }
    status.value = saveError.value
      ? 'failed'
      : Object.keys(pending).length > 0
        ? 'saving'
        : 'saved';
  }

  /** Revert to the base version ("Revert to v6"). */
  async function revert(): Promise<void> {
    if (!folder.value || !key.value) return;
    pending = {};
    take(await revertDraftTask(folder.value, key.value), null);
    savedTick.value++;
    void draftStore.load(folder.value).catch(() => undefined);
  }

  /** A write made elsewhere (an upload, a file move): the task as the API answered it. */
  function applyDetail(next: DraftTaskDetail): void {
    take(next, null);
    savedTick.value++;
  }

  return {
    folder,
    key,
    detail,
    loadError,
    form,
    taskYaml,
    prompt,
    reference,
    rubrics,
    keyDraft,
    keyProblem,
    locked,
    status,
    saveError,
    savedTick,
    open,
    reload,
    editForm,
    editYaml,
    editPrompt,
    editReference,
    editRubric,
    editKey,
    flush,
    revert,
    applyDetail,
  };
});

/**
 * What the task editor runs beside its autosave (SA.6 to SA.8): Try it on each answer check,
 * the worker self-check, and file uploads with their progress.
 *
 * - Try it scores in the API on what was last saved, so a try first sends what is waiting.
 *   Against the reference it runs again after every stored write (the card's "passes on the
 *   reference" chip stays live); a pasted reply is scored a moment after typing stops.
 * - The self-check runs file checks and verifier scripts in the worker (plan 4.6). Without a
 *   worker the API answers 503: the panel then says so and keeps the draft.
 * - A file over 25 MB is refused here at once ("ledger-2025.parquet is 31.2 MB. The limit is
 *   25 MB per file."), and only its first 25 MB and a byte go to the API, which refuses it
 *   too and keeps the refusal on the task, so readiness still reports it after a reload
 *   (Phase 5b question 11). `refusals` adds the ones the API keeps to those refused here;
 *   dismissing one deletes its path, which drops the API's record. Uploads run one per
 *   file, each with Cancel; leaving the editor while one runs asks first (SA.13).
 */
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { errorMessage, isApiError } from '@/api/client';
import {
  deleteDraftFile,
  getDraftFilePreview,
  getDraftFileText,
  moveDraftFile,
  runDraftSelfCheck,
  tryDraftCheck,
} from '@/api/drafts';
import { uploadDraftFile } from '@/api/drafts-upload';
import type { DraftUploadKind, TryCheckResult } from '@/api/types/authoring';
import type { TablePreview } from '@/api/types/suites';
import { kindFolder } from '@/components/authoring/files/fileRows';
import { useDraftTaskStore } from './draftTask';
import {
  OVER_LIMIT_REASON,
  keptRefusals as keptRefusalsOf,
  mergeRefusals,
  refusalHead,
  type RejectedFile,
} from './draftRefusals';

export { OVER_LIMIT_REASON, type RejectedFile };

const ANSWER_TYPES: readonly string[] = [
  'numeric_tolerance',
  'json_match',
  'exact_match',
  'text_match',
];
/** Pause after the last keystroke in a pasted reply before it is scored. */
export const TRY_DEBOUNCE_MS = 400;

export interface TryState {
  reference: TryCheckResult | null;
  referenceError: string | null;
  reply: string;
  replyResult: TryCheckResult | null;
  replyError: string | null;
  busy: boolean;
}

export type SelfCheckState = 'idle' | 'running' | 'offline' | 'failed';

export interface UploadItem {
  id: number;
  name: string;
  /** Where it goes, as the drop zone shows it: `/workspace/ledger.csv`. */
  target: string;
  kind: DraftUploadKind;
  loaded: number;
  total: number;
  controller: AbortController;
}

const emptyTry = (): TryState => ({
  reference: null,
  referenceError: null,
  reply: '',
  replyResult: null,
  replyError: null,
  busy: false,
});

export const useDraftTaskToolsStore = defineStore('draftTaskTools', () => {
  const task = useDraftTaskStore();

  const tries = ref<Record<string, TryState>>({});
  const selfCheckState = ref<SelfCheckState>('idle');
  const selfCheckError = ref<string | null>(null);
  const uploads = ref<UploadItem[]>([]);
  const rejected = ref<RejectedFile[]>([]);
  const fileError = ref<string | null>(null);
  /** Read-only file texts by path (a verifier's source), fetched once per task. */
  const sources = ref<Record<string, { text: string | null; error: string | null }>>({});
  /** First rows of CSV files by path; null for a file that is not tabular. */
  const previews = ref<Record<string, TablePreview | null>>({});
  let nextUpload = 1;
  const replyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const uploading = computed(() => uploads.value.length > 0);
  /** Paths of kept refusals dismissed while a file is stored there (a DELETE would remove it). */
  const dismissedPaths = ref<string[]>([]);

  /** Uploads the API refused for their size and keeps on the task, read from its readiness. */
  const keptRefusals = computed(() => keptRefusalsOf(task.detail?.readiness.issues ?? []));

  /** What the drop zones list: the files refused here, then those the API keeps. */
  const refusals = computed<RejectedFile[]>(() =>
    mergeRefusals(rejected.value, keptRefusals.value, dismissedPaths.value),
  );

  function tryOf(checkKey: string): TryState {
    if (!tries.value[checkKey]) tries.value[checkKey] = emptyTry();
    return tries.value[checkKey]!;
  }

  function answerKeys(): string[] {
    return (task.form?.checks ?? []).filter((c) => ANSWER_TYPES.includes(c.type)).map((c) => c.key);
  }

  async function score(checkKey: string, reply: string | null): Promise<void> {
    const f = task.folder;
    const k = task.key;
    if (!f || !k) return;
    const state = tryOf(checkKey);
    state.busy = true;
    try {
      const result = await tryDraftCheck(f, k, { key: checkKey, reply });
      if (reply === null) [state.reference, state.referenceError] = [result, null];
      else if (state.reply === reply) [state.replyResult, state.replyError] = [result, null];
    } catch (err) {
      if (reply === null) [state.reference, state.referenceError] = [null, errorMessage(err)];
      else [state.replyResult, state.replyError] = [null, errorMessage(err)];
    } finally {
      state.busy = false;
    }
  }

  /** Try every answer check against the reference, on what is saved. */
  async function refreshReferenceTries(): Promise<void> {
    if (task.locked) return;
    const keys = answerKeys();
    for (const key of Object.keys(tries.value)) {
      if (!keys.includes(key)) delete tries.value[key];
    }
    await Promise.all(keys.map((key) => score(key, null)));
  }

  /** A pasted reply: scored a moment after typing stops; an empty one clears the result. */
  function setReply(checkKey: string, reply: string): void {
    const state = tryOf(checkKey);
    state.reply = reply;
    const timer = replyTimers.get(checkKey);
    if (timer) clearTimeout(timer);
    if (reply.trim() === '') {
      [state.replyResult, state.replyError] = [null, null];
      return;
    }
    replyTimers.set(
      checkKey,
      setTimeout(() => {
        void (async () => {
          await task.flush();
          await score(checkKey, reply);
        })();
      }, TRY_DEBOUNCE_MS),
    );
  }

  watch(
    () => task.savedTick,
    () => void refreshReferenceTries(),
  );

  /** Run self-check: the worker materialises the task and runs the loader's own checks. */
  async function runSelfCheck(): Promise<void> {
    if (!task.folder || !task.key || selfCheckState.value === 'running') return;
    selfCheckState.value = 'running';
    selfCheckError.value = null;
    try {
      await task.flush();
      await runDraftSelfCheck(task.folder, task.key);
      await task.reload();
      selfCheckState.value = 'idle';
    } catch (err) {
      const offline = isApiError(err) && err.status === 503;
      selfCheckState.value = offline ? 'offline' : 'failed';
      selfCheckError.value = errorMessage(err);
    }
  }

  /** Where a file of a kind lands, as the agent or the checks see it. */
  function targetOf(kind: DraftUploadKind, path: string): string {
    if (kind === 'fixture') return `/workspace/${path}`;
    if (kind === 'home_seed') return `~/${path}`;
    const folder = kind === 'expected' ? task.form?.expectedWorkspace : task.form?.expectedHome;
    return `${folder ?? kind}/${path}`;
  }

  /**
   * Adds files to the task: each `path` is relative to what was dropped (`docs/terms.pdf`
   * from a folder), `prefix` a folder inside the kind's folder (`docs/`), and a home seed's
   * path is `memories/<name>`. Each file uploads on its own.
   */
  async function upload(
    items: Array<{ file: File; path: string }>,
    kind: DraftUploadKind,
    prefix = '',
  ): Promise<void> {
    const f = task.folder;
    const k = task.key;
    if (!f || !k) return;
    fileError.value = null;
    await Promise.all(
      items.map(async ({ file, path: dropped }) => {
        const path = kind === 'home_seed' ? `memories/${file.name}` : `${prefix}${dropped}`;
        if (file.size > AUTHORING_LIMITS.suiteMaxFileBytes) {
          rejected.value.push({
            name: file.name,
            kind,
            sizeBytes: file.size,
            reason: OVER_LIMIT_REASON,
            path: `${kindFolder(kind, task.form?.expectedWorkspace ?? null, task.form?.expectedHome ?? null)}/${path}`,
          });
          await reportRefusal(f, task.key ?? k, file, { kind, path });
          return;
        }
        const item: UploadItem = {
          id: nextUpload++,
          name: file.name,
          target: targetOf(kind, path),
          kind,
          loaded: 0,
          total: file.size,
          controller: new AbortController(),
        };
        uploads.value.push(item);
        try {
          const next = await uploadDraftFile(
            f,
            task.key ?? k,
            file,
            { kind, path },
            {
              signal: item.controller.signal,
              onProgress: ({ loaded, total }) => {
                const live = uploads.value.find((u) => u.id === item.id);
                if (live) [live.loaded, live.total] = [loaded, total];
              },
            },
          );
          task.applyDetail(next);
          previews.value = {};
        } catch (err) {
          if (!item.controller.signal.aborted) {
            rejected.value.push({
              name: file.name,
              kind,
              sizeBytes: file.size,
              reason: isApiError(err) ? err.detail : errorMessage(err),
            });
          }
        } finally {
          uploads.value = uploads.value.filter((u) => u.id !== item.id);
        }
      }),
    );
  }

  /**
   * Sends the first limit + 1 bytes of a file refused here, so the API refuses it as well
   * (413) and keeps the refusal on the task. Nothing of the file is stored; any answer is
   * fine, since the row says so already.
   */
  async function reportRefusal(
    folder: string,
    key: string,
    file: File,
    fields: { kind: DraftUploadKind; path: string },
  ): Promise<void> {
    try {
      task.applyDetail(await uploadDraftFile(folder, key, refusalHead(file), fields));
    } catch {
      // The expected 413: the refusal is kept, and shows on the next read of the task.
    }
  }

  /** A file the section refuses before sending it (a home file that is not a memory). */
  function rejectFile(file: File, kind: DraftUploadKind, reason: string): void {
    rejected.value.push({ name: file.name, kind, sizeBytes: file.size, reason });
  }

  function cancelUpload(id: number): void {
    uploads.value.find((u) => u.id === id)?.controller.abort();
  }

  function cancelAllUploads(): void {
    for (const item of uploads.value) item.controller.abort();
  }

  /**
   * Hides a refused file. A refusal the API keeps goes by deleting its path, unless a file is
   * stored there (an earlier upload a bigger one tried to replace): then it is only hidden.
   */
  async function dismissRejected(name: string): Promise<void> {
    const row = refusals.value.find((r) => r.name === name);
    rejected.value = rejected.value.filter((r) => r.name !== name);
    const path = row?.path;
    if (!path || !task.folder || !task.key) return;
    if (task.detail?.files.some((f) => f.path === path)) {
      dismissedPaths.value = [...dismissedPaths.value, path];
      return;
    }
    try {
      task.applyDetail(await deleteDraftFile(task.folder, task.key, path));
    } catch {
      // Nothing kept at that path (the API never learned of it): nothing to drop.
    }
  }

  async function removeFile(path: string): Promise<void> {
    if (!task.folder || !task.key) return;
    try {
      task.applyDetail(await deleteDraftFile(task.folder, task.key, path));
      fileError.value = null;
    } catch (err) {
      fileError.value = errorMessage(err);
    }
  }

  async function renameFile(path: string, next: string): Promise<boolean> {
    if (!task.folder || !task.key) return false;
    try {
      task.applyDetail(await moveDraftFile(task.folder, task.key, path, { path: next }));
      fileError.value = null;
      return true;
    } catch (err) {
      fileError.value = errorMessage(err);
      return false;
    }
  }

  /** A verify/ script's source, read once for its read-only view (V6). */
  async function loadSource(path: string): Promise<void> {
    if (!task.folder || !task.key || sources.value[path]) return;
    sources.value[path] = { text: null, error: null };
    try {
      const { text } = await getDraftFileText(task.folder, task.key, path);
      sources.value[path] = { text, error: null };
    } catch (err) {
      sources.value[path] = { text: null, error: errorMessage(err) };
    }
  }

  /** The first rows of a CSV workspace file, for its Preview row. */
  async function loadPreview(path: string): Promise<void> {
    if (!task.folder || !task.key || path in previews.value) return;
    try {
      previews.value[path] = await getDraftFilePreview(task.folder, task.key, path);
    } catch (err) {
      fileError.value = errorMessage(err);
    }
  }

  /** A new task in the editor starts with nothing tried, running or uploading. */
  function reset(): void {
    cancelAllUploads();
    for (const timer of replyTimers.values()) clearTimeout(timer);
    replyTimers.clear();
    tries.value = {};
    selfCheckState.value = 'idle';
    selfCheckError.value = null;
    uploads.value = [];
    rejected.value = [];
    dismissedPaths.value = [];
    fileError.value = null;
    sources.value = {};
    previews.value = {};
  }

  return {
    tries,
    selfCheckState,
    selfCheckError,
    uploads,
    uploading,
    rejected,
    refusals,
    fileError,
    sources,
    previews,
    tryOf,
    refreshReferenceTries,
    setReply,
    runSelfCheck,
    upload,
    rejectFile,
    cancelUpload,
    cancelAllUploads,
    dismissRejected,
    removeFile,
    renameFile,
    loadSource,
    loadPreview,
    reset,
  };
});

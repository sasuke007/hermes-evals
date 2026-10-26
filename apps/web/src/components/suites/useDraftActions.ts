/**
 * The authoring actions of Suite detail and Task detail (SA.1, SA.3, the TaskDetail board's
 * Edit task and Restore): each starts the folder's draft, or reuses the one open, does its
 * part and opens the draft page or the task editor. Nothing on disk changes until the draft
 * is saved. One action runs at a time; a failure is kept for the page's banner.
 */
import { ref } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { errorMessage } from '@/api/client';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import {
  draftLocation,
  draftTaskLocation,
  importTasksLocation,
} from '@/views/suites/authoringRoutes';

export type DraftAction =
  'edit' | 'duplicate' | 'remove' | 'blank' | 'import' | 'details' | 'restore';

export function useDraftActions(folder: () => string) {
  const store = useSuiteAuthoringStore();
  const router = useRouter();
  /** The action in flight, with its task key when it has one. */
  const busy = ref<{ action: DraftAction; key: string | null } | null>(null);
  const error = ref<string | null>(null);

  async function run(
    action: DraftAction,
    key: string | null,
    step: () => Promise<RouteLocationRaw>,
  ): Promise<void> {
    if (busy.value) return;
    busy.value = { action, key };
    error.value = null;
    try {
      await router.push(await step());
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      busy.value = null;
    }
  }

  const editTask = (key: string) =>
    run('edit', key, async () => {
      await store.startDraft(folder());
      return draftTaskLocation(folder(), key);
    });

  const duplicateTask = (key: string) =>
    run('duplicate', key, async () => {
      const result = await store.addTask(folder(), { kind: 'duplicate', from: key });
      return draftTaskLocation(folder(), result.keys[0]!);
    });

  const removeTask = (key: string) =>
    run('remove', key, async () => {
      await store.removeTask(folder(), key);
      return draftLocation(folder());
    });

  const blankTask = () =>
    run('blank', null, async () => {
      const result = await store.addTask(folder(), { kind: 'blank' });
      return draftTaskLocation(folder(), result.keys[0]!);
    });

  const importTasks = () =>
    run('import', null, async () => {
      await store.startDraft(folder());
      return importTasksLocation(folder());
    });

  const editDetails = () =>
    run('details', null, async () => {
      await store.startDraft(folder());
      return draftLocation(folder(), true);
    });

  /** Copies task `key` of suite version `suiteVersion` into the draft, from its blobs. */
  const restoreTask = (suiteVersion: number, key: string) =>
    run('restore', key, async () => {
      await store.addTask(folder(), { kind: 'restore', suiteVersion, key });
      return draftLocation(folder());
    });

  return {
    busy,
    error,
    editTask,
    duplicateTask,
    removeTask,
    blankTask,
    importTasks,
    editDetails,
    restoreTask,
    clearError: () => (error.value = null),
  };
}

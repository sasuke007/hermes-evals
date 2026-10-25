/**
 * Suites and tasks, as the Suites pages read them (UI_FLOWS 8): the list, each suite version
 * by id with its History, each task version by suite id and key with its version history,
 * the diffs opened, and the fixture previews fetched. A version's files never change once
 * loaded, but what is said about it does: the experiments that ran a task (TaskDetail's
 * experiments, with their status and pass rate) and each suite version's "Used by
 * experiments". So the pages revalidate on every visit (`force`), drawing the kept record
 * first. Diffs and previews are fetched once. A reload (the only thing that changes what the
 * directory serves) refreshes the list and drops what depends on the current pointer
 * (details, tasks, histories), so the next read fetches it again.
 *
 * Pages call the loaders and keep their own loading and error state; the list's state lives
 * here because the reload buttons of two pages drive it.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { errorMessage } from '@/api/client';
import {
  getFixturePreview,
  getSuite,
  getSuiteHistory,
  getTask,
  getTaskDiff,
  getTaskHistory,
  listSuites,
  reloadSuites,
} from '@/api/suites';
import type {
  SuiteDetail,
  SuiteHistoryEntry,
  SuiteListRow,
  SuiteReloadEntry,
  SuiteReloadResult,
  TablePreview,
  TaskDetail,
  TaskDiff,
  TaskVersionEntry,
} from '@/api/types/suites';

/** Key of a task version: its suite version id and its key. */
export const taskKeyOf = (suiteId: string, key: string): string => `${suiteId}/${key}`;
/** Key of a diff: the task, and the suite version it is compared against. */
export const diffKeyOf = (suiteId: string, key: string, against: string): string =>
  `${suiteId}/${key}@${against}`;
const previewKeyOf = (suiteId: string, key: string, path: string): string =>
  `${suiteId}/${key}:${path}`;

export interface ReloadState {
  /** The directory being reloaded, or null for every directory. */
  path: string | null;
}

export const useSuitesStore = defineStore('suites', () => {
  const list = ref<SuiteListRow[]>([]);
  const listLoaded = ref(false);
  const listLoading = ref(false);
  const listError = ref<string | null>(null);

  const suites = ref<Record<string, SuiteDetail>>({});
  const histories = ref<Record<string, SuiteHistoryEntry[]>>({});
  const tasks = ref<Record<string, TaskDetail>>({});
  const taskHistories = ref<Record<string, TaskVersionEntry[]>>({});
  const diffs = ref<Record<string, TaskDiff>>({});
  const previews = ref<Record<string, TablePreview | null>>({});

  /** The reload in flight (one at a time: the API serialises them anyway). */
  const reloading = ref<ReloadState | null>(null);
  /** The last reload's answer, until the next one; its lines go under "Last loaded". */
  const lastReload = ref<SuiteReloadResult | null>(null);
  /** The last reload's failure (503 no worker, 504 timeout, …), verbatim. */
  const reloadError = ref<string | null>(null);
  /** Which directory the failed reload was for (null: every directory). */
  const reloadErrorPath = ref<string | null>(null);

  const busy = computed(() => reloading.value !== null);

  async function loadList(): Promise<void> {
    listLoading.value = true;
    try {
      list.value = await listSuites();
      listError.value = null;
      listLoaded.value = true;
    } catch (err) {
      listError.value = errorMessage(err);
    } finally {
      listLoading.value = false;
    }
  }

  /** A suite version: the kept record, or a fetch (`force` always fetches). */
  async function loadSuite(id: string, force = false): Promise<SuiteDetail> {
    const known = suites.value[id];
    if (known && !force) return known;
    const detail = await getSuite(id);
    suites.value[id] = detail;
    return detail;
  }

  async function loadHistory(id: string, force = false): Promise<SuiteHistoryEntry[]> {
    const known = histories.value[id];
    if (known && !force) return known;
    const history = await getSuiteHistory(id);
    histories.value[id] = history;
    return history;
  }

  async function loadTask(suiteId: string, key: string, force = false): Promise<TaskDetail> {
    const id = taskKeyOf(suiteId, key);
    const known = tasks.value[id];
    if (known && !force) return known;
    const detail = await getTask(suiteId, key);
    tasks.value[id] = detail;
    return detail;
  }

  async function loadTaskHistory(
    suiteId: string,
    key: string,
    force = false,
  ): Promise<TaskVersionEntry[]> {
    const id = taskKeyOf(suiteId, key);
    const known = taskHistories.value[id];
    if (known && !force) return known;
    const history = await getTaskHistory(suiteId, key);
    taskHistories.value[id] = history;
    return history;
  }

  async function loadDiff(suiteId: string, key: string, against: string): Promise<TaskDiff> {
    const id = diffKeyOf(suiteId, key, against);
    const known = diffs.value[id];
    if (known) return known;
    const diff = await getTaskDiff(suiteId, key, against);
    diffs.value[id] = diff;
    return diff;
  }

  /** A fixture's first rows (null when the file is not tabular). */
  async function loadPreview(
    suiteId: string,
    key: string,
    path: string,
  ): Promise<TablePreview | null> {
    const id = previewKeyOf(suiteId, key, path);
    if (id in previews.value) return previews.value[id] ?? null;
    const preview = await getFixturePreview(suiteId, key, path);
    previews.value[id] = preview;
    return preview;
  }

  /**
   * Reload one directory (`path` as the list shows it) or all of them, then refresh the list.
   * Details, tasks and histories are dropped: the current version, the version selector and
   * the History panel may have moved. Resolves to the answer, or null when the request failed
   * (the message is in reloadError).
   */
  async function reload(path: string | null = null): Promise<SuiteReloadResult | null> {
    if (reloading.value) return null;
    reloading.value = { path };
    reloadError.value = null;
    reloadErrorPath.value = null;
    try {
      const result = await reloadSuites(path ?? undefined);
      lastReload.value = result;
      suites.value = {};
      histories.value = {};
      tasks.value = {};
      taskHistories.value = {};
      await loadList();
      return result;
    } catch (err) {
      reloadError.value = errorMessage(err);
      reloadErrorPath.value = path;
      return null;
    } finally {
      reloading.value = null;
    }
  }

  /** The last reload's line for a directory, if this session reloaded it. */
  function reloadEntryFor(path: string): SuiteReloadEntry | null {
    return lastReload.value?.suites.find((s) => s.sourcePath === path) ?? null;
  }

  /** True while `path` (or every directory) is being reloaded. */
  function isReloading(path: string): boolean {
    const r = reloading.value;
    return r !== null && (r.path === null || r.path === path);
  }

  function clearReloadError(): void {
    reloadError.value = null;
    reloadErrorPath.value = null;
  }

  return {
    list,
    listLoaded,
    listLoading,
    listError,
    suites,
    histories,
    tasks,
    taskHistories,
    diffs,
    previews,
    reloading,
    lastReload,
    reloadError,
    reloadErrorPath,
    busy,
    loadList,
    loadSuite,
    loadHistory,
    loadTask,
    loadTaskHistory,
    loadDiff,
    loadPreview,
    reload,
    reloadEntryFor,
    isReloading,
    clearReloadError,
  };
});

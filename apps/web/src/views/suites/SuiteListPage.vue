<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { SuiteListRow } from '@/api/types/suites';
import ImportSuiteDialog from '@/components/authoring/import/ImportSuiteDialog.vue';
import PageContainer from '@/components/layout/PageContainer.vue';
import {
  draftChipText,
  hhmm,
  isMissing,
  lastChangeOf,
  lastChangeText,
  progressLine,
} from '@/components/suites/authoringFormat';
import DraftChip from '@/components/suites/DraftChip.vue';
import ReloadFailedBanner from '@/components/suites/ReloadFailedBanner.vue';
import ReloadIcon from '@/components/suites/ReloadIcon.vue';
import { lastLoadLine, reloadLine, type LoadLine } from '@/components/suites/suiteFormat';
import BaseTag from '@/components/ui/BaseTag.vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import DataTable from '@/components/ui/DataTable.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import type { DataTableColumn } from '@/components/ui/types';
import { formatDateTime, MISSING, plural, shortHash } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import { useSuitesStore } from '@/stores/suites';
import { draftLocation, folderOf, newSuiteLocation } from './authoringRoutes';

/**
 * Suites (SuiteList, SuiteListStates, LibraryStates boards; SA.1; UI_FLOWS 8.1 and 8.2): one
 * row per folder under ./suites at its current version, with the changes that created it and
 * how the last reload went. New suite and Import .zip start a draft; a suite with an open
 * draft carries a chip that links to it, and new suites not saved yet are listed above the
 * table. "Reload all from disk" sends one job per folder, and each row shows where its folder
 * stands; a row's button reloads that folder alone. Folders gone from disk are hidden behind
 * "Show N missing from disk" (Phase 5 question 16). Suites never call a model, so this page
 * shows no model-access nudge.
 */
const store = useSuitesStore();
const authoring = useSuiteAuthoringStore();
onMounted(() => {
  void store.loadList();
  void authoring.loadDrafts();
});

const VISIBLE_TYPES = 3;
/** The folder format, for a first suite written by hand (no task page exists yet to show it). */
const FOLDER_FORMAT_URL =
  'https://github.com/sasuke007/hermes-evals#suites-generators-and-the-sample-skills';
const importOpen = ref(false);
const showMissing = ref(false);

const columns: DataTableColumn<SuiteListRow>[] = [
  { key: 'name', label: 'Name', skeleton: 90 },
  { key: 'version', label: 'Version', skeleton: 110 },
  { key: 'change', label: 'Last change', skeleton: 140 },
  { key: 'taskCount', label: 'Tasks', align: 'right', skeleton: 24 },
  { key: 'validCount', label: 'Valid', align: 'right', skeleton: 40 },
  { key: 'types', label: 'Verification types', skeleton: 220 },
  { key: 'path', label: 'Path', mono: true, skeleton: 140 },
  { key: 'loaded', label: 'Last loaded', skeleton: 160 },
  { key: 'actions', label: '', align: 'right', skeleton: 110 },
];

const missing = computed(() => store.list.filter(isMissing));
const present = computed(() => store.list.filter((row) => !isMissing(row)));
const rows = computed(() => (showMissing.value ? store.list : present.value));
const newDrafts = computed(() => authoring.newSuiteDrafts());

const loading = computed(() => !store.listLoaded && !store.listError);
/** Nothing on disk and no draft: the first-launch state, with missing folders behind the toggle. */
const empty = computed(
  () =>
    store.listLoaded &&
    present.value.length === 0 &&
    newDrafts.value.length === 0 &&
    !store.listError &&
    !showMissing.value,
);
const countLine = computed(() => (store.listLoaded ? plural(present.value.length, 'suite') : null));
const failedRows = computed(() =>
  store.list.filter((row) => row.lastLoad.outcome === 'error' && row.lastLoad.error),
);

function loadLine(row: SuiteListRow): LoadLine {
  const progress = store.progressFor(row.path);
  if (progress) return progressLine(progress);
  // Reload all reads the folders on disk: one it does not list is not being reloaded.
  if (store.reloadProgress) return lastLoadLine(row);
  if (store.isReloading(row.path))
    return { text: 'Reloading and running self-checks…', problem: false };
  const entry = store.reloadEntryFor(row.path);
  return entry ? reloadLine(entry) : lastLoadLine(row);
}

/** A row's button reads "Reloading…" only while its own folder loads. */
function rowBusy(row: SuiteListRow): boolean {
  const progress = store.progressFor(row.path);
  if (progress) return progress.state === 'loading';
  return !store.reloadProgress && store.isReloading(row.path);
}

const suiteTo = (row: SuiteListRow) => ({ name: ROUTE_NAMES.suite, params: { id: row.suiteId } });
const draftOf = (row: SuiteListRow) => authoring.draftOf(folderOf(row.path));
const newSuiteTo = newSuiteLocation;
const reloadAll = (): void => void store.reload(null);
const reloadOne = (row: SuiteListRow): void => void store.reload(row.path);
const retryFailedReload = (): void => void store.reload(store.reloadErrorPath);
</script>

<template>
  <PageContainer variant="list">
    <PageHeader title="Suites" :count="countLine">
      <template #meta>
        <p class="flex items-center gap-6 text-text-2">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="text-text-3">
            <path
              d="M1.5 3.5h4l1.2 1.5h5.8v6.5h-11z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </svg>
          <span
            >Suites are folders in <code>./suites</code>. Create and edit them here, or edit the
            files and reload.</span
          >
        </p>
      </template>
      <template #actions>
        <RouterLink class="btn primary" :to="newSuiteTo" data-testid="new-suite">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          New suite
        </RouterLink>
        <button type="button" class="btn" data-testid="import-zip" @click="importOpen = true">
          Import .zip
        </button>
        <button
          type="button"
          class="btn"
          :disabled="store.busy"
          data-testid="reload-all"
          @click="reloadAll"
        >
          <ReloadIcon :spinning="store.reloading !== null && store.reloading.path === null" />
          Reload all from disk
        </button>
      </template>
    </PageHeader>

    <ErrorBanner
      v-if="store.reloadError"
      title="Could not reload suites"
      :detail="store.reloadError"
      hint="Reloading runs in the worker: check that it is up (System, or docker compose ps worker)."
      :retry-label="store.busy ? null : 'Try again'"
      data-testid="reload-error"
      @retry="retryFailedReload"
    />

    <ReloadFailedBanner
      v-for="row in failedRows"
      :key="row.path"
      :name="row.name"
      :error="row.lastLoad.error!"
      :served-version="row.lastLoad.servedVersion"
      :busy="store.busy"
      @retry="reloadOne(row)"
    />

    <section
      v-if="newDrafts.length"
      aria-label="New suites not saved yet"
      class="flex flex-col rounded-6 border border-border bg-surface"
      data-testid="new-suite-drafts"
    >
      <div
        v-for="draft in newDrafts"
        :key="draft.id"
        class="flex flex-wrap items-center gap-x-12 gap-y-4 border-b border-border px-14 py-10 last:border-b-0"
      >
        <RouterLink :to="draftLocation(draft.folder)" class="font-mono font-semibold text-text">{{
          draft.name
        }}</RouterLink>
        <span class="chip bg-que-soft text-que-text">not saved yet</span>
        <span class="text-12 text-text-3"
          >{{ draftChipText(draft) }} · {{ plural(draft.taskCount, 'task') }} · last edited
          {{ hhmm(draft.updatedAt) }} · <code>{{ draft.path }}</code></span
        >
        <RouterLink :to="draftLocation(draft.folder)" class="btn sm ml-auto">Open draft</RouterLink>
      </div>
    </section>

    <template v-if="empty">
      <div
        class="flex flex-col items-center gap-10 rounded-6 border border-border bg-surface px-24 py-56 text-center"
        data-testid="suites-empty"
      >
        <b class="text-15">No suites yet</b>
        <p class="max-w-560 text-text-2">
          A suite is a set of tasks your agent is tested on: a prompt, input files, a hidden answer
          and checks.
        </p>
        <div class="mt-6 flex gap-8">
          <RouterLink class="btn primary" :to="newSuiteTo">Create a suite</RouterLink>
          <button type="button" class="btn" @click="importOpen = true">Import a .zip</button>
        </div>
        <div class="mt-14 flex flex-wrap items-center justify-center gap-8 text-12 text-text-3">
          <span>Or put a suite folder in <code>./suites</code> and reload.</span>
          <span
            class="inline-flex h-28 items-center gap-8 rounded-4 border border-border bg-surface-2 pr-4 pl-10 font-mono text-12 text-text"
            >./suites<CopyButton text="./suites" label="Copy ./suites"
          /></span>
          <a
            class="text-12"
            :href="FOLDER_FORMAT_URL"
            target="_blank"
            rel="noopener"
            data-testid="folder-format"
            >See the folder format</a
          >
        </div>
      </div>
      <button
        v-if="missing.length && !loading"
        type="button"
        class="linkbtn self-start text-12"
        :aria-expanded="showMissing"
        data-testid="toggle-missing"
        @click="showMissing = !showMissing"
      >
        {{ showMissing ? 'Hide' : 'Show' }} {{ missing.length }} missing from disk
      </button>
    </template>

    <template v-else>
      <DataTable
        :columns="columns"
        :rows="rows"
        row-key="path"
        :loading="loading"
        :skeleton-rows="2"
        :error="store.listError"
        error-title="Could not load suites"
        label="Suites"
        table-class="h44 static"
        @retry="store.loadList()"
      >
        <template #cell-name="{ row }">
          <span class="inline-flex items-center gap-8">
            <RouterLink :to="suiteTo(row)" class="font-mono font-semibold text-text">{{
              row.name
            }}</RouterLink>
            <DraftChip v-if="draftOf(row)" :draft="draftOf(row)!" />
          </span>
        </template>
        <template #cell-version="{ row }">
          <span class="font-mono font-semibold">v{{ row.versionNumber }}</span>
          {{ ' ' }}
          <span v-if="row.versionLabel" class="text-text-3" title="Author label from suite.yaml">{{
            row.versionLabel
          }}</span>
          {{ ' ' }}
          <BaseTag :title="row.contentHash">{{ shortHash(row.contentHash) }}</BaseTag>
        </template>
        <template #cell-change="{ row }">
          <template v-if="lastChangeOf(row)">
            <span
              :class="
                lastChangeOf(row)!.kind === 'now invalid' ? 'font-medium text-fail-text' : undefined
              "
              >{{ lastChangeText(lastChangeOf(row)!).lead }}</span
            >
            <template v-if="lastChangeText(lastChangeOf(row)!).keys">
              {{ ' ' }}
              <code>{{ lastChangeText(lastChangeOf(row)!).keys }}</code>
            </template>
          </template>
          <span v-else-if="row.lastLoad.outcome === 'unchanged'" class="text-text-3"
            >Unchanged since v{{ row.versionNumber }}</span
          >
          <span v-else class="text-text-3">{{ MISSING }}</span>
        </template>
        <template #cell-validCount="{ row }">
          <span
            :class="
              row.validCount < row.taskCount ? 'font-semibold text-fail-text' : 'text-pass-text'
            "
            >{{ row.validCount }} / {{ row.taskCount }}</span
          >
        </template>
        <template #cell-types="{ row }">
          <div class="flex flex-wrap gap-4">
            <BaseTag v-for="type in row.verificationTypes.slice(0, VISIBLE_TYPES)" :key="type">{{
              type
            }}</BaseTag>
            <BaseTag
              v-if="row.verificationTypes.length > VISIBLE_TYPES"
              :title="row.verificationTypes.slice(VISIBLE_TYPES).join(', ')"
              >+{{ row.verificationTypes.length - VISIBLE_TYPES }}</BaseTag
            >
          </div>
        </template>
        <template #cell-path="{ row }">
          <span class="text-text-2">{{ row.path }}</span>
        </template>
        <template #cell-loaded="{ row }">
          <div class="flex flex-col leading-16">
            <span class="text-text-2">{{ formatDateTime(row.loadedAt) }}</span>
            <!-- The reload's message can be long ("Created v2 · 1 task changed: … · 1 task now
                 invalid: …"): it wraps rather than pushing the row's Reload off the table. -->
            <span
              class="block max-w-240 text-12 whitespace-normal"
              :class="loadLine(row).problem ? 'text-fail-text' : 'text-text-3'"
              role="status"
              data-testid="load-line"
              >{{ loadLine(row).text }}</span
            >
          </div>
        </template>
        <template #cell-actions="{ row }">
          <button
            type="button"
            class="btn sm"
            :disabled="store.busy"
            :aria-label="`Reload ${row.name} from disk`"
            @click="reloadOne(row)"
          >
            {{ rowBusy(row) ? 'Reloading…' : 'Reload from disk' }}
          </button>
        </template>
      </DataTable>
      <button
        v-if="missing.length && !loading"
        type="button"
        class="linkbtn self-start text-12"
        :aria-expanded="showMissing"
        data-testid="toggle-missing"
        @click="showMissing = !showMissing"
      >
        {{ showMissing ? 'Hide' : 'Show' }} {{ missing.length }} missing from disk
      </button>
      <p v-if="!loading && !store.listError" class="text-12 text-text-3">
        Saving a draft writes the folder and loads it exactly as a reload does. A reload re-reads
        every <code>task.yaml</code>, re-hashes fixtures and re-runs each task's self-check: every
        verification entry is scored against the task's own reference answer, and must pass. Each
        reload that finds a change creates a new suite version (v1, v2, …), numbered by the
        platform; the number next to it is the author label from <code>suite.yaml</code>.
        Experiments keep the version they were created on.
      </p>
    </template>

    <ImportSuiteDialog v-model:open="importOpen" />
  </PageContainer>
</template>

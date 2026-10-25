<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import type { SuiteListRow } from '@/api/types/suites';
import PageContainer from '@/components/layout/PageContainer.vue';
import ReloadFailedBanner from '@/components/suites/ReloadFailedBanner.vue';
import ReloadIcon from '@/components/suites/ReloadIcon.vue';
import {
  changePhrases,
  keysText,
  lastLoadLine,
  reloadLine,
  type LoadLine,
} from '@/components/suites/suiteFormat';
import BaseTag from '@/components/ui/BaseTag.vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import DataTable from '@/components/ui/DataTable.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import type { DataTableColumn } from '@/components/ui/types';
import { formatDateTime, MISSING, shortHash } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useSuitesStore } from '@/stores/suites';

/**
 * Suites (SuiteList, SuiteListStates, LibraryStates boards; UI_FLOWS 8.1 and 8.2): one row
 * per folder under ./suites at its current version, with what the last reload changed and
 * how it went. "Reload all from disk" re-reads every folder and re-runs every self-check;
 * a row's button reloads that folder alone. Suites never call a model, so this page shows
 * no model-access nudge.
 */
const store = useSuitesStore();
onMounted(() => void store.loadList());

const VISIBLE_TYPES = 3;

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

const loading = computed(() => !store.listLoaded && !store.listError);
const empty = computed(() => store.listLoaded && store.list.length === 0 && !store.listError);
const countLine = computed(() =>
  store.listLoaded ? `${store.list.length} suite${store.list.length === 1 ? '' : 's'}` : null,
);
const failedRows = computed(() =>
  store.list.filter((row) => row.lastLoad.outcome === 'error' && row.lastLoad.error),
);

/** The first change worth naming: what became invalid before what changed. */
const firstChange = (row: SuiteListRow) => changePhrases(row.lastLoad.changes)[0] ?? null;

function loadLine(row: SuiteListRow): LoadLine {
  if (store.isReloading(row.path))
    return { text: 'Reloading and running self-checks…', problem: false };
  const entry = store.reloadEntryFor(row.path);
  return entry ? reloadLine(entry) : lastLoadLine(row);
}

const suiteTo = (row: SuiteListRow) => ({ name: ROUTE_NAMES.suite, params: { id: row.suiteId } });
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
          <span>Suites are folders in <code>./suites</code>. Edit the files and reload.</span>
        </p>
      </template>
      <template #actions>
        <!-- Phase 5b adds "New suite" (primary) and "Import .zip" before this button. -->
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

    <EmptyState
      v-if="empty"
      title="No suites yet"
      body="A suite is a set of tasks your agent is tested on: a prompt, input files, a hidden answer and checks."
    >
      <!-- Phase 5b adds "Create a suite" (primary) and "Import a .zip" here, and the line below starts "Or put"; the board draws both. -->
      <div class="mt-14 flex flex-wrap items-center justify-center gap-8 text-12 text-text-3">
        <span>Put a suite folder in <code>./suites</code> and reload.</span>
        <span
          class="inline-flex h-28 items-center gap-8 rounded-4 border border-border bg-surface-2 pr-4 pl-10 font-mono text-12 text-text"
          >./suites<CopyButton text="./suites" label="Copy ./suites"
        /></span>
      </div>
    </EmptyState>

    <template v-else>
      <DataTable
        :columns="columns"
        :rows="store.list"
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
          <RouterLink :to="suiteTo(row)" class="font-mono font-semibold text-text">{{
            row.name
          }}</RouterLink>
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
          <template v-if="firstChange(row)">
            <span
              :class="
                firstChange(row)!.kind === 'now invalid' ? 'font-medium text-fail-text' : undefined
              "
              >{{ firstChange(row)!.keys.length }} {{ firstChange(row)!.kind }}:</span
            >
            {{ ' ' }}
            <code>{{ keysText(firstChange(row)!) }}</code>
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
            {{ store.isReloading(row.path) ? 'Reloading…' : 'Reload from disk' }}
          </button>
        </template>
      </DataTable>
      <p v-if="!loading && !store.listError" class="text-12 text-text-3">
        A reload re-reads every <code>task.yaml</code>, re-hashes fixtures and re-runs each task's
        self-check: every verification entry is scored against the task's own reference answer, and
        must pass. Each reload that finds a change creates a new suite version (v1, v2, …), numbered
        by the platform; the number next to it is the author label from <code>suite.yaml</code>.
        Experiments keep the version they were created on.
      </p>
    </template>
  </PageContainer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { errorMessage } from '@/api/client';
import type { TablePreview, TaskFixtureFile } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { useSuitesStore } from '@/stores/suites';
import { formatBytes, formatSha256 } from '@/lib/format';
import TablePreviewTable from './TablePreviewTable.vue';
import ZoneLabel from './ZoneLabel.vue';

/**
 * A task's fixtures (TaskDetail board): each file as the agent finds it in /workspace, with
 * its type, size and hash, and "changed in vN" when this task version changed it. A tabular
 * file opens a preview of its first rows: inline when the task detail carries it, fetched
 * otherwise. The first inline preview starts open.
 */
const props = withDefaults(
  defineProps<{
    suiteId: string;
    taskKey: string;
    fixtures: TaskFixtureFile[];
    /** Task version on screen, for the "changed in vN" note. */
    version: number;
    /** Files this task version changed (task paths: fixtures/invoices.csv). */
    changedFiles?: string[];
  }>(),
  { changedFiles: () => [] },
);

const store = useSuitesStore();
const open = ref<string | null>(null);
const fetched = ref<Record<string, TablePreview | null>>({});
const pending = ref<string | null>(null);
const error = ref<string | null>(null);

watch(
  () => props.fixtures,
  (files) => {
    open.value = files.find((f) => f.preview !== null)?.path ?? null;
    fetched.value = {};
    error.value = null;
  },
  { immediate: true },
);

const TABULAR = /\.(csv|tsv)$/i;
const canPreview = (f: TaskFixtureFile): boolean => f.preview !== null || TABULAR.test(f.path);
const changed = (f: TaskFixtureFile): boolean => props.changedFiles.includes(`fixtures/${f.path}`);
const previewOf = (f: TaskFixtureFile): TablePreview | null =>
  f.preview ?? fetched.value[f.path] ?? null;

async function toggle(f: TaskFixtureFile): Promise<void> {
  error.value = null;
  if (open.value === f.path) {
    open.value = null;
    return;
  }
  open.value = f.path;
  if (f.preview || f.path in fetched.value) return;
  pending.value = f.path;
  try {
    fetched.value = {
      ...fetched.value,
      [f.path]: await store.loadPreview(props.suiteId, props.taskKey, f.path),
    };
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    pending.value = null;
  }
}

const openFile = (): TaskFixtureFile | null =>
  props.fixtures.find((f) => f.path === open.value) ?? null;
</script>

<template>
  <BasePanel aria-labelledby="task-fixtures" clip>
    <template #header>
      <div class="flex items-center justify-between gap-10 border-b border-border px-16 py-12">
        <span class="flex flex-wrap items-center gap-10">
          <h2 id="task-fixtures" class="text-15 font-semibold">Fixtures</h2>
          <ZoneLabel zone="visible" />
          <span class="text-12 text-text-3"
            >Copied into the agent's workspace before every run</span
          >
        </span>
      </div>
    </template>
    <p v-if="fixtures.length === 0" class="px-16 py-12 text-text-2">
      None. The agent starts in an empty workspace.
    </p>
    <div v-else class="overflow-x-auto">
      <table class="dt th30 inset14 static" aria-label="Fixtures">
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">Type</th>
            <th scope="col" class="text-right">Size</th>
            <th scope="col">Hash</th>
            <th scope="col"><span class="sr-only">Preview</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in fixtures" :key="f.path" :data-fixture="f.path">
            <td class="font-mono text-12 whitespace-normal">
              /workspace/{{ f.path }}
              <span v-if="changed(f)" class="font-sans text-12 text-run-text"
                >changed in v{{ version }}</span
              >
            </td>
            <td class="whitespace-normal text-text-2">{{ f.typeLabel }}</td>
            <td class="text-right">{{ formatBytes(f.sizeBytes) }}</td>
            <td class="font-mono text-12 text-text-2" :title="f.sha256">
              {{ formatSha256(f.sha256) }}
            </td>
            <td class="text-right">
              <button
                v-if="canPreview(f)"
                type="button"
                class="btn"
                :aria-expanded="open === f.path ? 'true' : 'false'"
                :disabled="pending === f.path"
                @click="toggle(f)"
              >
                {{ open === f.path ? 'Hide preview' : 'Preview' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-if="openFile()"
      class="flex flex-col gap-6 border-t border-border px-16 pt-12 pb-16"
      data-testid="fixture-preview"
    >
      <ErrorBanner v-if="error" title="Could not load the preview" :detail="error" compact />
      <p v-else-if="pending === open" class="text-12 text-text-3">Loading the first rows…</p>
      <template v-else-if="previewOf(openFile()!)">
        <span class="text-12 text-text-3"
          >First {{ previewOf(openFile()!)!.rows.length }} of
          {{ previewOf(openFile()!)!.totalRows }} rows</span
        >
        <TablePreviewTable :preview="previewOf(openFile()!)!" :label="openFile()!.path" />
      </template>
      <p v-else class="text-12 text-text-3">This file has no table preview.</p>
    </div>
  </BasePanel>
</template>

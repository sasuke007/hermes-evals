<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { errorMessage } from '@/api/client';
import { getArtifactPreview, getArtifactText, type ArtifactText } from '@/api/runs';
import type { ArtifactView } from '@/api/types/runs';
import type { TablePreview } from '@/api/types/suites';
import { formatCount, formatBytes } from '@/lib/format';
import { fileName, previewKind } from './inspectorFormat';

/**
 * One artifact's inline preview, opened from the Artifacts table (RunInspector › Artifacts):
 * a CSV or TSV as a table of its first rows ("showing 5 of 48 rows"), any other text file
 * as plain text, exactly as written and never rendered. The table comes with the run
 * detail when the file is small; otherwise both are fetched when the preview opens.
 */
const props = defineProps<{ runId: string; artifact: ArtifactView }>();

const kind = computed(() => previewKind(props.artifact));
const table = ref<TablePreview | null>(null);
const text = ref<ArtifactText | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  error.value = null;
  if (kind.value === 'table' && props.artifact.preview) {
    table.value = props.artifact.preview;
    return;
  }
  loading.value = true;
  try {
    if (kind.value === 'table') {
      table.value = await getArtifactPreview(props.runId, props.artifact.id);
    } else {
      text.value = await getArtifactText(props.runId, props.artifact.id);
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => props.artifact.id, load);

const name = computed(() => fileName(props.artifact.path));
const format = computed(() => (props.artifact.path.toLowerCase().endsWith('.tsv') ? 'TSV' : 'CSV'));
const tableCaption = computed(() => {
  const t = table.value;
  if (!t) return '';
  return t.rows.length < t.totalRows
    ? `showing ${formatCount(t.rows.length)} of ${formatCount(t.totalRows)} rows`
    : `${formatCount(t.totalRows)} ${t.totalRows === 1 ? 'row' : 'rows'}`;
});
const textCaption = computed(() => {
  const t = text.value;
  if (!t) return '';
  if (t.truncated) {
    return `first ${formatBytes(t.text.length)} of ${formatBytes(props.artifact.sizeBytes)}`;
  }
  const lines = t.text === '' ? 0 : t.text.replace(/\n$/, '').split('\n').length;
  return `${formatCount(lines)} ${lines === 1 ? 'line' : 'lines'} · ${formatBytes(props.artifact.sizeBytes)}`;
});
</script>

<template>
  <div
    class="overflow-hidden rounded-6 border border-border bg-surface"
    :class="kind === 'table' ? 'flex-[1.4_1_420px]' : 'flex-[1_1_320px]'"
    :aria-busy="loading || undefined"
    data-testid="artifact-preview"
    :data-kind="kind"
  >
    <div class="flex justify-between gap-8 border-b border-border px-12 py-8 text-12 text-text-3">
      <span
        >Preview · <span class="font-mono">{{ name }}</span> ·
        {{ kind === 'table' ? format : 'plain text' }}</span
      >
      <span>{{ kind === 'table' ? tableCaption : textCaption }}</span>
    </div>
    <div v-if="error" class="p-12">
      <ErrorBanner
        compact
        title="Could not load the preview"
        :detail="error"
        retry-label="Retry"
        @retry="load"
      />
    </div>
    <div v-else-if="loading" class="flex flex-col gap-8 px-12 py-10" aria-hidden="true">
      <span v-for="i in 4" :key="i" class="block h-10 animate-shimmer rounded-3 bg-surface-3" />
    </div>
    <template v-else-if="kind === 'table'">
      <div v-if="table" class="overflow-x-auto">
        <table class="dt static" :aria-label="`Preview of ${name}`">
          <thead>
            <tr>
              <th v-for="(column, i) in table.columns" :key="i">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in table.rows" :key="r">
              <td v-for="(cell, c) in row" :key="c" class="h-auto py-6 font-mono text-12">
                {{ cell }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="px-12 py-10 text-12 text-text-3">This file has no table to preview.</p>
    </template>
    <template v-else-if="text">
      <pre
        class="max-h-[420px] overflow-auto px-12 py-10 font-mono text-12 leading-18 break-words whitespace-pre-wrap"
        :aria-label="`Contents of ${name}`"
        >{{ text.text }}</pre>
      <div class="px-12 pb-10 text-12 text-text-3">
        Shown exactly as written, in monospace, with no formatting applied.
      </div>
    </template>
  </div>
</template>

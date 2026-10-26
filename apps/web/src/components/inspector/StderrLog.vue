<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ATTEMPT_STDERR_MAX_BYTES } from '@hermes-evals/shared';
import CopyButton from '@/components/ui/CopyButton.vue';
import { getAttemptStderr } from '@/api/runs';
import type { AttemptStderr } from '@/api/types/runs';
import { ApiError } from '@/api/client';
import { formatBytes, formatCount, plural } from '@/lib/format';

/**
 * An attempt's stderr under the execution-error banner (RunInspectorStates › Execution
 * error): the stored tail with Copy and "Full log". Full log reads the whole stderr.log
 * (GET /runs/:id/attempts/:n/stderr) and shows it in place, with Download for a .log file;
 * a log over 1 MB comes back as its end, and the caption says so. Tail goes back.
 */
const props = defineProps<{
  runId: string;
  attempt: number;
  /** The stored tail: its last lines, and how many the whole log has. */
  lines: readonly string[];
  totalLines: number;
}>();

const full = ref<AttemptStderr | null>(null);
const loading = ref(false);
const failure = ref<string | null>(null);
/** Each load gets a number; an answer for an earlier one (another attempt shown) is dropped. */
let loadSeq = 0;

watch(
  () => [props.runId, props.attempt],
  () => {
    loadSeq++;
    full.value = null;
    loading.value = false;
    failure.value = null;
  },
);

const tailText = computed(() => props.lines.join('\n'));
const shownText = computed(() =>
  full.value ? full.value.text.replace(/\n$/, '') : tailText.value,
);

const caption = computed(() => {
  const log = full.value;
  if (log?.truncated) {
    return `stderr · last ${formatBytes(ATTEMPT_STDERR_MAX_BYTES)} of ${formatBytes(log.sizeBytes)} · ${formatCount(log.totalLines)} lines in all`;
  }
  if (log) return `stderr · all ${plural(log.totalLines, 'line')} · ${formatBytes(log.sizeBytes)}`;
  if (!props.lines.length) return 'stderr · nothing written';
  const total = Math.max(props.totalLines, props.lines.length);
  return `stderr · last ${formatCount(props.lines.length)} of ${formatCount(total)} ${total === 1 ? 'line' : 'lines'}`;
});

async function showFull(): Promise<void> {
  const seq = ++loadSeq;
  loading.value = true;
  failure.value = null;
  try {
    const log = await getAttemptStderr(props.runId, props.attempt);
    if (seq === loadSeq) full.value = log;
  } catch (e) {
    if (seq !== loadSeq) return;
    failure.value =
      e instanceof ApiError && e.status === 404
        ? `No full log is stored for attempt ${props.attempt}: it wrote nothing more, or it ended before the worker kept full logs. The tail below is stored with the run.`
        : `Could not load the full log: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

function showTail(): void {
  loadSeq++;
  full.value = null;
  failure.value = null;
}

/** The file name Download gives the log: "stderr-<run>-attempt-2.log". */
const fileName = computed(() => `stderr-${props.runId}-attempt-${props.attempt}.log`);

function download(): void {
  const log = full.value;
  if (!log) return;
  const url = URL.createObjectURL(new Blob([log.text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.value;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="stderr">
    <div class="flex flex-wrap items-center justify-between gap-8">
      <span class="text-12 text-text-3" data-testid="stderr-caption">{{ caption }}</span>
      <span v-if="lines.length" class="flex gap-6">
        <CopyButton
          variant="button"
          :text="shownText"
          :label="full ? 'Copy the full log' : 'Copy the stderr tail'"
          button-text="Copy"
        />
        <button
          v-if="full"
          type="button"
          class="btn mid"
          :title="fileName"
          data-testid="stderr-download"
          @click="download"
        >
          Download
        </button>
        <button
          v-if="full"
          type="button"
          class="btn mid"
          data-testid="stderr-tail-button"
          @click="showTail"
        >
          Tail
        </button>
        <button
          v-else
          type="button"
          class="btn mid"
          :disabled="loading"
          data-testid="full-log"
          @click="showFull"
        >
          {{ loading ? 'Loading…' : 'Full log' }}
        </button>
      </span>
    </div>
    <p v-if="failure" role="alert" class="text-12 text-fail-text" data-testid="full-log-error">
      {{ failure }}
    </p>
    <pre
      v-if="lines.length"
      class="overflow-auto rounded-4 border border-border bg-surface px-12 py-10 font-mono text-12 leading-18 break-words whitespace-pre-wrap text-text"
      :class="{ 'max-h-480': full }"
      :aria-label="full ? 'stderr, full log' : 'stderr tail'"
      :data-testid="full ? 'stderr-full' : 'stderr-tail'"
      >{{ shownText }}</pre>
  </div>
</template>

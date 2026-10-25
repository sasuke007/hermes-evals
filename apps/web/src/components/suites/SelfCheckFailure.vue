<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { SelfCheckFailureView } from '@/api/types/suites';
import { formatDateTime, formatDateTimeSeconds } from '@/lib/format';

/**
 * Why a task failed its self-check, as its expanded row on Suite detail shows it (Flow D,
 * step 3): the headline, when it ran and how the same check did on the previous load, the
 * command and its output exactly as captured, the likely cause, a way to the task, and for
 * a verifier script the contract it must keep.
 */
const props = withDefaults(
  defineProps<{
    failure: SelfCheckFailureView;
    /** "Open task detail" goes here; none on the task page itself. */
    taskTo?: RouteLocationRaw | null;
  }>(),
  { taskTo: null },
);

const isScript = computed(() => props.failure.type === 'verifier_script');
/** The script named in the headline: "verifier_script check_late_fees.py printed …". */
const script = computed(
  () => /^verifier_script (\S+\.\w+)/.exec(props.failure.title)?.[1] ?? '<script>',
);
const seconds = computed(() => `${(props.failure.durationMs / 1000).toFixed(1)} s`);
</script>

<template>
  <div class="flex max-w-1040 flex-col gap-8" data-testid="self-check-failure">
    <div class="flex flex-wrap items-baseline gap-x-16 gap-y-6">
      <b class="text-fail-text">{{ failure.title }}</b>
      <span class="text-12 text-text-3"
        >key <span class="font-mono">{{ failure.key }}</span> · ran
        {{ formatDateTimeSeconds(failure.ranAt) }} · {{ seconds
        }}<template v-if="failure.previousRun">
          · previous run {{ formatDateTime(failure.previousRun.at) }}
          {{ failure.previousRun.status }}</template
        ></span
      >
    </div>
    <pre
      class="rounded-4 border border-border bg-surface px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
      data-testid="failure-transcript"
      >{{ failure.transcript }}</pre>
    <p class="text-text-2">{{ failure.explanation }}</p>
    <div v-if="taskTo" class="flex flex-wrap items-center gap-8">
      <!-- Phase 5b adds "Edit task" (primary) here. -->
      <RouterLink class="btn sm" :to="taskTo">Open task detail</RouterLink>
      <span v-if="isScript" class="text-12 text-text-3">Verifier scripts are edited on disk.</span>
    </div>
    <p v-if="isScript" class="text-12 text-text-3">
      Contract: the platform runs
      <code>python3 verify/{{ script }} --answer &lt;answer.json&gt; --workspace &lt;dir&gt;</code>
      in the script's folder. The last line it prints must be JSON
      <code>{"score": 0.0–1.0, "comment": "…"}</code>; only <code>score</code> and
      <code>comment</code> are read. A non-zero exit, a timeout or a missing line is error. The
      self-check needs the reference answer to reach the check's pass threshold.
    </p>
  </div>
</template>

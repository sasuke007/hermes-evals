<script setup lang="ts">
import { computed } from 'vue';
import type { DraftSelfCheckResult } from '@/api/types/authoring';
import CodeText from '../editors/CodeText.vue';

/**
 * Check against the expected workspace (SA.7, File check): the check runs in the worker
 * against `expected/` laid over the workspace files, then against the untouched workspace,
 * which must fail (the negative control). The results are the task's last self-check for
 * this key; "Run in the worker" runs the task's self-check.
 */
const props = withDefaults(
  defineProps<{
    /** This key's results in the last self-check, if any. */
    results: DraftSelfCheckResult[];
    /** Seconds the last self-check took, for "· 0.3 s". */
    seconds: number | null;
    running?: boolean;
    /** Out of date: the task changed after the run. */
    stale?: boolean;
    expectedFolder: string | null;
    disabled?: boolean;
  }>(),
  { running: false, stale: false, disabled: false },
);
defineEmits<{ run: [] }>();

const positive = computed(() => props.results.find((r) => r.expect === 'pass') ?? null);
const negative = computed(() => props.results.find((r) => r.expect === 'fail') ?? null);
const score = (r: DraftSelfCheckResult) =>
  r.score === null ? 'no score' : `score ${Number(r.score.toFixed(2))}`;
</script>

<template>
  <div
    class="flex flex-col gap-8 rounded-6 border border-border bg-surface px-12 py-10"
    data-testid="expected-run"
  >
    <div class="flex items-center justify-between gap-10">
      <b>Check against the expected workspace</b>
      <button type="button" class="btn sm" :disabled="running || disabled" @click="$emit('run')">
        {{ running ? 'Running…' : 'Run in the worker' }}
      </button>
    </div>
    <template v-if="positive && !stale">
      <div class="flex items-center gap-10 text-12">
        <span
          class="chip"
          :class="
            positive.status === 'passed'
              ? 'bg-pass-soft text-pass-text'
              : 'bg-fail-soft text-fail-text'
          "
          ><span
            class="size-6 rounded-full"
            :class="positive.status === 'passed' ? 'bg-pass' : 'bg-fail'"
          />{{ positive.status }}</span
        >
        <span
          >On the expected workspace: <CodeText :text="positive.comment" /> · {{ score(positive)
          }}<template v-if="seconds !== null"> · {{ seconds }} s</template></span
        >
      </div>
      <div v-if="negative" class="flex items-center gap-10 text-12">
        <span v-if="negative.status !== 'passed'" class="chip bg-que-soft text-que-text"
          ><span class="size-7 rounded-full border-[1.5px] border-que" />failed, as it should</span
        >
        <span v-else class="chip bg-fail-soft text-fail-text"
          ><span class="size-6 rounded-full bg-fail" />passed, so doing nothing would pass</span
        >
        <span
          >Negative control, on the untouched workspace: <CodeText :text="negative.comment" /> ·
          {{ score(negative) }}.</span
        >
      </div>
    </template>
    <span v-else class="text-12 text-text-3"
      >Runs in the platform's worker against <code>{{ expectedFolder ?? 'expected' }}/</code> laid
      over the workspace files, then against the untouched workspace (negative control). Takes a few
      seconds.</span
    >
  </div>
</template>

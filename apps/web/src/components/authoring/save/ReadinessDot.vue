<script setup lang="ts">
import type { TaskReadinessSummary } from '@/api/types/authoring';

/**
 * A task's readiness as an 8px dot (SA.3, SA.8, SA.11): passed rows solid green, warnings
 * amber, problems violet and dotted, a self-check not run a grey ring. Never the only sign:
 * the word goes beside it.
 */
defineProps<{ readiness: TaskReadinessSummary }>();

const CLASSES: Record<TaskReadinessSummary, string> = {
  ready: 'bg-pass',
  warnings: 'bg-ung',
  problems: 'border-[1.5px] border-dotted border-err bg-err-soft',
  not_run: 'border-[1.5px] border-que bg-transparent',
};
</script>

<template>
  <span
    class="inline-block size-8 flex-none rounded-full"
    :class="CLASSES[readiness]"
    :data-readiness="readiness"
    aria-hidden="true"
  />
</template>

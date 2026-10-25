<script setup lang="ts">
import { computed } from 'vue';
import StatusDot from './StatusDot.vue';
import { TONE_CLASSES, statusTone, type StatusKind } from '@/lib/statusTones';

/**
 * One chip for every status value in the product. The text is always the exact status word
 * from the data model (or the table's drawn word for providers), never a synonym. Tone, dot
 * and weight come from src/lib/statusTones.ts.
 */
const props = withDefaults(
  defineProps<{
    /** The raw value: a run status, score status, experiment status, verdict, provider status… */
    status: string;
    /** Needed because "failed" and "error" exist in more than one group. */
    kind: StatusKind;
    /** Optional number after the label, in mono (filter bars: "failed 3"). */
    count?: number | null;
    /** sm (18px, inside 28px table rows) or md (20px). */
    size?: 'sm' | 'md';
    /** false: running and scoring draw a solid dot instead of pulsing. */
    live?: boolean;
    /** false hides the dot. */
    dot?: boolean;
  }>(),
  { count: null, size: 'md', live: true, dot: true },
);

const tone = computed(() => statusTone(props.kind, props.status, { live: props.live }));
const classes = computed(() => {
  const t = tone.value;
  const colours =
    t.appearance === 'dashed'
      ? 'bg-surface-2 text-text-2 border border-dashed border-border-strong'
      : t.appearance === 'muted'
        ? 'bg-surface-2 text-text-3'
        : TONE_CLASSES[t.tone].chip;
  return [
    colours,
    { sm: props.size === 'sm', 'font-semibold': t.strong },
    t.strong && !t.appearance ? TONE_CLASSES[t.tone].ring : '',
  ];
});
</script>

<template>
  <span
    class="chip"
    :class="classes"
    :data-kind="kind"
    :data-status="status"
    :data-tone="tone.tone"
    :data-strong="tone.strong ? 'true' : undefined"
    :data-size="size"
  >
    <StatusDot v-if="dot && tone.dot !== 'none'" :tone="tone.tone" :mode="tone.dot" />
    <slot>{{ tone.label }}</slot>
    <span
      v-if="count !== null && count !== undefined"
      class="font-mono text-11"
      data-testid="chip-count"
      >{{ count }}</span
    >
  </span>
</template>

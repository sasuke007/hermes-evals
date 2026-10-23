<script setup lang="ts">
import { computed } from 'vue';
import { statusTone, type StatusKind } from '@/lib/statusTones';

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
    /** With kind="experiment" status="paused": 'provider_disconnected' turns the chip amber. */
    pauseReason?: string | null;
  }>(),
  { count: null, size: 'md', live: true, dot: true, pauseReason: null },
);

const tone = computed(() =>
  statusTone(props.kind, props.status, { live: props.live, pauseReason: props.pauseReason }),
);
</script>

<template>
  <span
    class="chip status-chip"
    :class="[`tone-${tone.tone}`, { sm: size === 'sm', strong: tone.strong }]"
    :data-kind="kind"
    :data-status="status"
    :data-tone="tone.tone"
  >
    <span
      v-if="dot && tone.dot !== 'none'"
      class="dot"
      :class="{
        hollow: tone.dot === 'hollow',
        pulse: tone.dot === 'pulse',
        square: tone.dot === 'square',
      }"
      :data-dot="tone.dot"
      aria-hidden="true"
    />
    <slot>{{ tone.label }}</slot>
    <span v-if="count !== null && count !== undefined" class="count mono">{{ count }}</span>
  </span>
</template>

<style scoped>
.status-chip.strong {
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--tone);
}
.count {
  font-size: 11px;
}
</style>

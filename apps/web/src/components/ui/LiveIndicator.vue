<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { LiveState } from './types';

/**
 * Shows that the page is receiving live updates, and says so plainly when it is not.
 * The caller owns the stream and its backoff (1, 2, 5, 10 s; "offline" after 30 s); this
 * component only draws the state. "finished" hides itself after `hideFinishedAfterMs`.
 */
const props = withDefaults(
  defineProps<{
    state: LiveState;
    /** When the last event arrived; shown as "last update 14:52:08" when not live. */
    lastEventAt?: string | number | Date | null;
    /** Replaces "Live", e.g. "1 running · 87 / 120". */
    label?: string | null;
    /** Reconnect attempt number: "Reconnecting (attempt 3)". */
    attempt?: number | null;
    /** 0 keeps "Finished" visible. */
    hideFinishedAfterMs?: number;
  }>(),
  { lastEventAt: null, label: null, attempt: null, hideFinishedAfterMs: 5000 },
);
defineEmits<{ retry: [] }>();

const hidden = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function clearHide(): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = null;
}

watch(
  () => props.state,
  (state) => {
    clearHide();
    hidden.value = false;
    if (state === 'finished' && props.hideFinishedAfterMs > 0) {
      hideTimer = setTimeout(() => (hidden.value = true), props.hideFinishedAfterMs);
    }
  },
  { immediate: true },
);
onBeforeUnmount(clearHide);

function clock(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const lastUpdate = computed(() =>
  props.lastEventAt !== null && props.lastEventAt !== undefined
    ? `last update ${clock(props.lastEventAt)}`
    : null,
);

const text = computed(() => {
  switch (props.state) {
    case 'live':
      return props.label ?? 'Live';
    case 'reconnecting':
      return [
        props.attempt ? `Reconnecting (attempt ${props.attempt})` : 'Reconnecting',
        lastUpdate.value,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'paused':
      return ['Paused', lastUpdate.value].filter(Boolean).join(' · ');
    case 'offline':
      return ['Offline', lastUpdate.value].filter(Boolean).join(' · ');
    default:
      return 'Finished';
  }
});
</script>

<template>
  <span v-if="!hidden" class="live" :class="`live-${state}`" role="status" :data-state="state">
    <svg
      v-if="state === 'finished'"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M2 6.5l2.5 2.5L10 3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span
      v-else
      class="dot"
      :class="{
        pulse: state === 'live',
        hollow: state === 'reconnecting' || state === 'paused',
      }"
      aria-hidden="true"
    />
    <span>{{ text }}</span>
    <button v-if="state === 'offline'" type="button" class="linkbtn retry" @click="$emit('retry')">
      Retry
    </button>
  </span>
</template>

<style scoped>
.live {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  font-size: 12px;
  white-space: nowrap;
}
.live-live {
  --tone: var(--run);
  color: var(--run-text);
}
.live-reconnecting {
  --tone: var(--ung);
  color: var(--ung-text);
}
.live-paused {
  --tone: var(--que);
  color: var(--text-2);
}
.live-offline {
  --tone: var(--fail);
  color: var(--fail-text);
}
.live-finished {
  color: var(--pass-text);
}
.retry {
  margin-left: -4px;
  font-size: 12px;
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import StatusDot from './StatusDot.vue';
import type { Tone } from '@/lib/statusTones';
import type { LiveState } from './types';

/**
 * Shows that the page is receiving live updates, and says so plainly when it is not.
 * The caller owns the stream and its backoff (1, 2, 5, 10 s; "offline" after 30 s); this
 * component only draws the state. "finished" hides itself after `hideFinishedAfterMs`.
 *
 * Only the state ("Live", "Reconnecting (attempt 3)", "Offline") is a live region, so screen
 * readers hear it change; the time after it ("updated 15:23:42", "last update 15:23:42")
 * moves with every event and is read in place, never announced.
 */
const props = withDefaults(
  defineProps<{
    state: LiveState;
    /** When the last event arrived; shown as "last update 14:52:08" when not live. */
    lastEventAt?: string | number | Date | null;
    /** Replaces "Live", e.g. "1 running · 87 / 120" (announced when it changes). */
    label?: string | null;
    /** After the state while live, not announced: "updated 15:23:42". */
    detail?: string | null;
    /** Reconnect attempt number: "Reconnecting (attempt 3)". */
    attempt?: number | null;
    /** 0 keeps "Finished" visible. */
    hideFinishedAfterMs?: number;
  }>(),
  { lastEventAt: null, label: null, detail: null, attempt: null, hideFinishedAfterMs: 5000 },
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

/** Text colour and dot per state: blue live, amber reconnecting, neutral paused, orange offline. */
const LOOK: Record<Exclude<LiveState, 'finished'>, { ink: string; tone: Tone }> = {
  live: { ink: 'text-run-text', tone: 'run' },
  reconnecting: { ink: 'text-ung-text', tone: 'ung' },
  paused: { ink: 'text-text-2', tone: 'que' },
  offline: { ink: 'text-fail-text', tone: 'fail' },
};
const look = computed(() => (props.state === 'finished' ? null : LOOK[props.state]));

/** The state in words: the live region holds only this. */
const lead = computed(() => {
  switch (props.state) {
    case 'live':
      return props.label ?? 'Live';
    case 'reconnecting':
      return props.attempt ? `Reconnecting (attempt ${props.attempt})` : 'Reconnecting';
    case 'paused':
      return 'Paused';
    case 'offline':
      return 'Offline';
    default:
      return 'Finished';
  }
});
/** What follows the state, outside the live region. */
const trail = computed(() => {
  if (props.state === 'live') return props.detail;
  return props.state === 'finished' ? null : lastUpdate.value;
});
</script>

<template>
  <span
    v-if="!hidden"
    class="inline-flex h-24 items-center gap-8 text-12 whitespace-nowrap"
    :class="look?.ink ?? 'text-pass-text'"
    :data-state="state"
  >
    <svg v-if="!look" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2 6.5l2.5 2.5L10 3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <StatusDot
      v-else
      :tone="look.tone"
      :mode="
        state === 'live'
          ? 'pulse'
          : state === 'reconnecting' || state === 'paused'
            ? 'hollow'
            : 'solid'
      "
    />
    <span
      ><span role="status">{{ lead }}</span
      ><template v-if="trail">{{ ` · ${trail}` }}</template></span
    >
    <button
      v-if="state === 'offline'"
      type="button"
      class="linkbtn -ml-4 text-12"
      @click="$emit('retry')"
    >
      Retry
    </button>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { formatCountdown } from '@/stores/providers';

/**
 * Lives in the AppShell beside the running pill while a Nous login waits and the dialog is
 * closed. Clicking it reopens ConnectDialog in the waiting state.
 * Pass `left` (the store's countdown text) or `expiresAt` (the pill then runs its own clock).
 */
const props = withDefaults(
  defineProps<{
    left?: string | null;
    expiresAt?: string | number | null;
  }>(),
  { left: null, expiresAt: null },
);
defineEmits<{ open: [] }>();

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
watch(
  () => props.left === null && props.expiresAt !== null,
  (ownClock) => {
    stop();
    if (ownClock) timer = setInterval(() => (now.value = Date.now()), 1000);
  },
  { immediate: true },
);
onBeforeUnmount(stop);

const text = computed(() => {
  if (props.left !== null) return props.left;
  if (props.expiresAt === null) return '';
  const at = typeof props.expiresAt === 'number' ? props.expiresAt : Date.parse(props.expiresAt);
  return formatCountdown((at - now.value) / 1000);
});
</script>

<template>
  <button
    type="button"
    class="approval-pill"
    title="Reopen the Nous Portal login"
    @click="$emit('open')"
  >
    <span class="dot pulse tone-run" aria-hidden="true" />
    <span>Waiting for Nous approval</span>{{ ' ' }}<span aria-hidden="true">·</span>{{ ' '
    }}<span class="mono">{{ text }} left</span>
  </button>
</template>

<style scoped>
.approval-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--run);
  border-radius: 4px;
  background: var(--run-soft);
  color: var(--run-text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.approval-pill:hover {
  border-color: var(--run-text);
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import StatusDot from '@/components/ui/StatusDot.vue';
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
    class="inline-flex h-28 items-center gap-8 rounded-4 border border-run bg-run-soft px-10 text-12 font-medium whitespace-nowrap text-run-text hover:border-run-text"
    title="Reopen the Nous Portal login"
    data-testid="approval-pill"
    @click="$emit('open')"
  >
    <StatusDot tone="run" mode="pulse" />
    <span>Waiting for Nous approval</span>{{ ' ' }}<span aria-hidden="true">·</span>{{ ' '
    }}<span class="font-mono">{{ text }} left</span>
  </button>
</template>

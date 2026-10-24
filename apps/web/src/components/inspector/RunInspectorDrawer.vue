<script setup lang="ts">
/**
 * Run inspector drawer: a right-hand drawer at 75% of the viewport (min
 * 960px) over the page that opened it. Placeholder: the page builder replaces
 * the body and keeps these props and events.
 *
 * Props: runId (the run shown), experimentId, siblings (ordered run ids of the
 * calling view, for prev/next with J/K). Events: close (Esc, scrim, close
 * button), navigate(runId) (prev, next, the A/B jump).
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { X } from 'lucide-vue-next';

defineProps<{ runId: string; experimentId: string; siblings?: string[] }>();
const emit = defineEmits<{ close: []; navigate: [runId: string] }>();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="ri-scrim" data-testid="run-inspector-scrim" @click.self="emit('close')">
    <aside class="ri-drawer" role="dialog" aria-modal="true" aria-labelledby="ri-title">
      <header class="ri-head">
        <h2 id="ri-title" class="mono">{{ runId }}</h2>
        <button
          type="button"
          class="iconbtn"
          aria-label="Close run inspector (Esc)"
          title="Close · Esc"
          @click="emit('close')"
        >
          <X :size="16" aria-hidden="true" />
        </button>
      </header>
      <p class="t2">The run inspector is being built.</p>
    </aside>
  </div>
</template>

<style scoped>
.ri-scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--scrim);
  display: flex;
  justify-content: flex-end;
}
.ri-drawer {
  width: max(75vw, 960px);
  max-width: 100vw;
  height: 100%;
  overflow-y: auto;
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow);
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ri-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ri-head h2 {
  font-size: 15px;
  font-weight: 600;
}
</style>

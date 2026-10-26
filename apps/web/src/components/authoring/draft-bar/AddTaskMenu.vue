<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import { onClickOutside } from '@vueuse/core';

/**
 * "Add task ▾" in a suite draft's header (SA.3): Blank task, Duplicate a task… (which asks
 * which task in the menu), and Import from CSV or JSONL.
 */
defineProps<{
  keys: string[];
  importTo: RouteLocationRaw;
  disabled?: boolean;
}>();
const emit = defineEmits<{ blank: []; duplicate: [key: string] }>();

const open = ref(false);
const choosing = ref(false);
const chosen = ref('');
const root = ref<HTMLElement | null>(null);
const select = ref<HTMLSelectElement | null>(null);
onClickOutside(root, () => close());

function close(): void {
  open.value = false;
  choosing.value = false;
}

async function chooseDuplicate(keys: string[]): Promise<void> {
  choosing.value = true;
  chosen.value = keys[0] ?? '';
  await nextTick();
  select.value?.focus();
}

function blank(): void {
  close();
  emit('blank');
}

function duplicate(): void {
  if (chosen.value) emit('duplicate', chosen.value);
  close();
}
</script>

<template>
  <div ref="root" class="relative" @keydown.esc="close">
    <button
      type="button"
      class="btn"
      aria-haspopup="menu"
      :aria-expanded="open"
      :disabled="disabled"
      data-testid="add-task"
      @click="open = !open"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.25"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M12 5v14M5 12h14" /></svg
      >Add task<span class="text-text-3" aria-hidden="true">▾</span>
    </button>
    <div
      v-if="open"
      role="menu"
      class="absolute top-36 right-0 z-10 flex w-260 flex-col rounded-6 border border-border bg-surface p-4 shadow-float"
    >
      <button
        type="button"
        role="menuitem"
        class="rounded-4 px-10 py-6 text-left hover:bg-surface-2"
        @click="blank"
      >
        Blank task
      </button>
      <button
        v-if="!choosing"
        type="button"
        role="menuitem"
        class="rounded-4 px-10 py-6 text-left hover:bg-surface-2"
        :disabled="keys.length === 0"
        @click="chooseDuplicate(keys)"
      >
        Duplicate a task…
      </button>
      <div v-else class="flex items-center gap-6 px-6 py-4">
        <select
          ref="select"
          v-model="chosen"
          class="input sm min-w-0 flex-1 font-mono"
          aria-label="Task to duplicate"
        >
          <option v-for="k in keys" :key="k" :value="k">{{ k }}</option>
        </select>
        <button type="button" class="btn sm" @click="duplicate">Duplicate</button>
      </div>
      <RouterLink
        role="menuitem"
        class="rounded-4 px-10 py-6 text-text hover:bg-surface-2 hover:no-underline"
        :to="importTo"
        >Import from CSV or JSONL</RouterLink
      >
    </div>
  </div>
</template>

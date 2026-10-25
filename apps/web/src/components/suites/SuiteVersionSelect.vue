<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import type { SuiteVersionOption } from '@/api/types/suites';
import { formatDateTime } from '@/lib/format';
import { versionLabel } from './suiteFormat';

/**
 * The version selector beside a suite's name (SuiteDetail board): "v6 · current ▾" opens a
 * list of every version of the directory, current first, each with its load time. Arrow
 * keys move through it, Enter picks, Esc closes and returns focus to the button.
 */
const props = defineProps<{
  versions: SuiteVersionOption[];
  /** The version on screen. */
  viewedId: string;
}>();
const emit = defineEmits<{ select: [suiteId: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const options = ref<HTMLButtonElement[]>([]);

const viewed = computed(() => props.versions.find((v) => v.suiteId === props.viewedId) ?? null);
const labelOf = (v: SuiteVersionOption): string =>
  v.current ? `v${v.versionNumber} · current` : versionLabel(v.versionNumber, v.reverted);

onClickOutside(root, () => (open.value = false));

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (!open.value) return;
  await nextTick();
  const index = Math.max(
    0,
    props.versions.findIndex((v) => v.suiteId === props.viewedId),
  );
  options.value[index]?.focus();
}

function close(): void {
  open.value = false;
  trigger.value?.focus();
}

function pick(v: SuiteVersionOption): void {
  open.value = false;
  trigger.value?.focus();
  if (v.suiteId !== props.viewedId) emit('select', v.suiteId);
}

function onKeydown(event: KeyboardEvent): void {
  const list = options.value;
  const at = list.findIndex((el) => el === document.activeElement);
  const move = (i: number): void => {
    event.preventDefault();
    list[(i + list.length) % list.length]?.focus();
  };
  if (event.key === 'ArrowDown') move(at + 1);
  else if (event.key === 'ArrowUp') move(at - 1);
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(list.length - 1);
  else if (event.key === 'Escape') {
    event.preventDefault();
    close();
  } else if (event.key === 'Tab') open.value = false;
}
</script>

<template>
  <div ref="root" class="relative">
    <button
      ref="trigger"
      type="button"
      class="inline-flex h-28 items-center gap-8 rounded-4 border border-border-strong bg-surface pr-8 pl-10 font-mono text-12 text-text"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      aria-label="Suite version"
      data-testid="version-select"
      @click="toggle"
    >
      <b>{{ viewed ? labelOf(viewed) : 'Version' }}</b>
      <span class="text-text-3" aria-hidden="true">▾</span>
    </button>
    <div
      v-if="open"
      class="absolute top-32 left-0 z-5 flex min-w-260 flex-col rounded-6 border border-border bg-surface p-4 shadow-float"
      role="listbox"
      aria-label="Suite versions"
      @keydown="onKeydown"
    >
      <button
        v-for="v in versions"
        :key="`${v.suiteId}-${v.reverted}`"
        ref="options"
        type="button"
        role="option"
        :aria-selected="v.suiteId === viewedId ? 'true' : 'false'"
        class="flex h-30 items-center justify-between gap-12 rounded-4 border-0 bg-transparent px-8 text-left text-12 hover:bg-surface-2 aria-selected:bg-surface-2"
        @click="pick(v)"
      >
        <span class="font-mono font-semibold">{{ labelOf(v) }}</span>
        <span class="text-12 text-text-3">{{ formatDateTime(v.loadedAt) }}</span>
      </button>
    </div>
  </div>
</template>

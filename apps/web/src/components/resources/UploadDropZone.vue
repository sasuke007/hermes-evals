<script setup lang="ts">
import { ref } from 'vue';

/**
 * Step 1 of an upload dialog: a dashed zone that takes a dropped file, or opens the file
 * picker when clicked (Enter or Space from the keyboard). Emits the first file.
 * The title is the default slot ("Drop a skill zip here, or choose a file"); `caption` the
 * line under it (".zip up to 20 MB · must contain SKILL.md at its root").
 */
withDefaults(
  defineProps<{
    caption: string;
    /** The picker's accept list: ".zip,application/zip". */
    accept?: string | null;
    /** 36px (skills) or 28px (documents) above and below. */
    padding?: 'md' | 'sm';
  }>(),
  { accept: null, padding: 'md' },
);
const emit = defineEmits<{ file: [file: File] }>();

const input = ref<HTMLInputElement | null>(null);
const over = ref(false);

function pick(): void {
  input.value?.click();
}
function onChange(event: Event): void {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) emit('file', file);
  target.value = '';
}
function onDrop(event: DragEvent): void {
  over.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) emit('file', file);
}
defineExpose({ pick });
</script>

<template>
  <button
    type="button"
    class="flex w-full cursor-pointer flex-col items-center gap-6 rounded-6 border-[1.5px] border-dashed px-16 text-center"
    :class="[
      padding === 'md' ? 'py-36' : 'py-28',
      over ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface-2',
    ]"
    data-primary
    data-testid="drop-zone"
    @click="pick"
    @dragenter.prevent="over = true"
    @dragover.prevent="over = true"
    @dragleave="over = false"
    @drop.prevent="onDrop"
  >
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" class="text-text-3">
      <path
        d="M11 14V4M7 8l4-4 4 4M4 15v3h14v-3"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span class="font-medium"><slot /></span>
    <span class="text-12 text-text-3">{{ caption }}</span>
  </button>
  <input
    ref="input"
    type="file"
    class="hidden"
    :accept="accept ?? undefined"
    tabindex="-1"
    aria-hidden="true"
    data-testid="file-input"
    @change="onChange"
  />
</template>

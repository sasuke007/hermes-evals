<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

/**
 * Copies a value to the clipboard and confirms it for 1.5 s.
 * variant="icon": the 24 × 22 .copy button used inside .cmd blocks (aria-label required).
 * variant="button": a 28px button with the copy glyph and a word ("Copy" → "Copied").
 */
const props = withDefaults(
  defineProps<{
    text: string;
    variant?: 'icon' | 'button';
    /** Accessible name: "Copy command", "Copy code", "Copy run id". */
    label?: string;
    /** Visible word for variant="button". */
    buttonText?: string;
  }>(),
  { variant: 'icon', label: 'Copy', buttonText: 'Copy' },
);
const emit = defineEmits<{ copied: [text: string] }>();

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function fallbackCopy(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    area.remove();
  }
}

async function copy(): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(props.text);
    else fallbackCopy(props.text);
  } catch {
    fallbackCopy(props.text);
  }
  copied.value = true;
  emit('copied', props.text);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => (copied.value = false), 1500);
}
onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer);
});
</script>

<template>
  <button
    type="button"
    :class="
      variant === 'icon'
        ? 'inline-flex h-22 w-24 flex-none items-center justify-center rounded-3 border-0 bg-transparent text-text-3 hover:bg-surface-3 hover:text-text'
        : 'btn mid px-8'
    "
    :aria-label="label"
    :title="copied ? 'Copied' : label"
    @click="copy"
  >
    <svg v-if="copied" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2 6.5l2.5 2.5L10 3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <svg v-else width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect
        x="3.5"
        y="3.5"
        width="6.5"
        height="6.5"
        rx="1"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
      />
      <path d="M2 8V2.5A.5.5 0 0 1 2.5 2H8" fill="none" stroke="currentColor" stroke-width="1.3" />
    </svg>
    <template v-if="variant === 'button'">{{ copied ? 'Copied' : buttonText }}</template>
    <span class="sr-only" aria-live="polite">{{ copied ? 'Copied' : '' }}</span>
  </button>
</template>

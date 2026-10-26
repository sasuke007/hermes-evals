<script lang="ts">
/** One item of an ActionMenu. */
export interface ActionMenuItem {
  key: string;
  label: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId } from 'vue';

/**
 * A button that opens a small menu under it (SuiteDetail board: "Add task ▾" and a task
 * row's ⋯): its items, then an optional caption ("Any of these starts a draft. Nothing on
 * disk changes until you save."). Arrow keys move between items, Esc and a click outside
 * close it and give focus back to the button.
 */
withDefaults(
  defineProps<{
    items: ActionMenuItem[];
    /** The trigger's accessible name ("More actions for total_due"); its text is the slot. */
    label: string;
    caption?: string | null;
    /** Trigger style: a row's ghost ⋯, or a header button. */
    variant?: 'ghost' | 'button';
    align?: 'right' | 'left';
  }>(),
  { caption: null, variant: 'button', align: 'right' },
);
const emit = defineEmits<{ select: [key: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menuId = `menu-${useId()}`;

function onDocument(event: MouseEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) close(false);
}

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) {
    document.addEventListener('mousedown', onDocument);
    await nextTick();
    root.value?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  } else document.removeEventListener('mousedown', onDocument);
}

function close(refocus = true): void {
  open.value = false;
  document.removeEventListener('mousedown', onDocument);
  if (refocus) trigger.value?.focus();
}

function choose(key: string): void {
  close();
  emit('select', key);
}

function onKeydown(event: KeyboardEvent): void {
  if (!open.value) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = [
    ...(root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
  items[(next + items.length) % items.length]?.focus();
}

onBeforeUnmount(() => document.removeEventListener('mousedown', onDocument));
</script>

<template>
  <div ref="root" class="relative inline-flex" @keydown="onKeydown">
    <button
      ref="trigger"
      type="button"
      :class="variant === 'ghost' ? 'btn sm ghost px-6' : 'btn'"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="open ? menuId : undefined"
      @click="toggle"
    >
      <slot>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </slot>
    </button>
    <div
      v-if="open"
      :id="menuId"
      role="menu"
      class="absolute top-[calc(100%+4px)] z-30 flex min-w-240 flex-col rounded-6 border border-border bg-surface p-4 shadow-float"
      :class="align === 'right' ? 'right-0' : 'left-0'"
      data-testid="action-menu"
    >
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        role="menuitem"
        class="flex h-30 items-center gap-8 rounded-4 px-10 text-left text-13 whitespace-nowrap hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-45"
        :class="item.tone === 'danger' ? 'text-fail-text' : 'text-text'"
        :disabled="item.disabled"
        :data-item="item.key"
        @click="choose(item.key)"
      >
        {{ item.label }}
      </button>
      <span v-if="caption" class="px-10 pt-6 pb-4 text-12 whitespace-normal text-text-3">{{
        caption
      }}</span>
    </div>
  </div>
</template>

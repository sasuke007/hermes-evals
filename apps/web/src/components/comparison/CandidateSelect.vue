<script setup lang="ts">
import { onClickOutside } from '@vueuse/core';
import { computed, nextTick, ref, useId } from 'vue';
import type { ComparisonCandidateOption } from '@/api/types/experiments';
import { statusTone } from '@/lib/statusTones';

/**
 * The candidate select of an experiment with two or more candidates (ExperimentStates ›
 * Comparison · two or more candidates): a button that opens a listbox of the candidates, each
 * with its verdict on the primary key as a caption ("better", "provisional"). The grid and
 * the statistics always show one candidate against the baseline; picking another swaps them.
 *
 * Keyboard: Enter, Space or the arrows open it; the arrows, Home and End move; Enter or Space
 * picks; Esc or Tab closes it and focus returns to the button.
 */
const props = defineProps<{
  options: ComparisonCandidateOption[];
  /** The selected candidate's configuration version id. */
  modelValue: string;
  /** The button's id, for the label beside it. */
  id?: string;
  /** The label's id: the button reads as "Candidate with-skill". */
  labelledby?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [versionId: string] }>();

const uid = useId();
const buttonId = computed(() => props.id ?? `candidate-${uid}`);
const listId = `candidate-list-${uid}`;
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const list = ref<HTMLElement | null>(null);
const open = ref(false);
const active = ref(0);

const selectedIndex = computed(() =>
  Math.max(
    0,
    props.options.findIndex((o) => o.configuration.versionId === props.modelValue),
  ),
);
const selected = computed(() => props.options[selectedIndex.value] ?? null);
const optionId = (i: number): string => `${listId}-${i}`;
const caption = (o: ComparisonCandidateOption): string => statusTone('verdict', o.verdict).label;

async function show(at = selectedIndex.value): Promise<void> {
  active.value = at;
  open.value = true;
  await nextTick();
  list.value?.focus();
}

function close(refocus = true): void {
  open.value = false;
  if (refocus) button.value?.focus();
}

function pick(i: number): void {
  const option = props.options[i];
  if (option && option.configuration.versionId !== props.modelValue) {
    emit('update:modelValue', option.configuration.versionId);
  }
  close();
}

function onButtonKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    void show();
  }
}

function onListKeydown(event: KeyboardEvent): void {
  const last = props.options.length - 1;
  switch (event.key) {
    case 'ArrowDown':
      active.value = Math.min(last, active.value + 1);
      break;
    case 'ArrowUp':
      active.value = Math.max(0, active.value - 1);
      break;
    case 'Home':
      active.value = 0;
      break;
    case 'End':
      active.value = last;
      break;
    case 'Enter':
    case ' ':
      pick(active.value);
      break;
    case 'Escape':
      close();
      break;
    case 'Tab':
      close(false);
      return;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
}

onClickOutside(root, () => {
  if (open.value) close(false);
});
</script>

<template>
  <div ref="root" class="relative">
    <button
      :id="buttonId"
      ref="button"
      type="button"
      class="flex h-32 w-200 items-center justify-between gap-8 rounded-4 border bg-surface px-10"
      :class="open ? 'border-focus' : 'border-border-strong'"
      aria-haspopup="listbox"
      :aria-labelledby="labelledby ? `${labelledby} ${buttonId}` : undefined"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="listId"
      data-testid="candidate-select"
      @click="open ? close() : show()"
      @keydown="onButtonKeydown"
    >
      <span class="truncate font-mono">{{ selected?.configuration.name }}</span>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" class="flex-none">
        <path d="M3 4.5L6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>
    <ul
      v-show="open"
      :id="listId"
      ref="list"
      role="listbox"
      aria-label="Candidate"
      tabindex="-1"
      :aria-activedescendant="open ? optionId(active) : undefined"
      class="absolute top-full left-0 z-20 mt-4 w-200 rounded-6 border border-border bg-surface p-4 shadow-float outline-none"
      @keydown="onListKeydown"
    >
      <li
        v-for="(option, i) in options"
        :id="optionId(i)"
        :key="option.configuration.versionId"
        role="option"
        :aria-selected="i === selectedIndex ? 'true' : 'false'"
        class="flex h-30 cursor-pointer items-center justify-between gap-8 rounded-4 px-8"
        :class="[
          i === selectedIndex ? 'bg-accent-soft' : 'hover:bg-surface-2',
          { 'inset-ring-[1.5px] inset-ring-focus': i === active },
        ]"
        @click="pick(i)"
        @mousemove="active = i"
      >
        <span class="truncate font-mono" :class="{ 'font-semibold': i === selectedIndex }">{{
          option.configuration.name
        }}</span>
        <span class="text-12 text-text-3">{{ caption(option) }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

/**
 * A list of names as chips with a text box at the end (the MCP form's environment variables,
 * include and exclude): Enter, a comma or leaving the box adds what was typed; × or
 * Backspace in an empty box removes a chip. A name already in the list is not added twice.
 * `transform` normalises what was typed (upper case for environment variables). The whole
 * bordered box reads as one field, so a press anywhere in it outside a chip puts the caret in
 * the text box.
 */
const props = withDefaults(
  defineProps<{
    /** Names the group: "Environment variable names". */
    label: string;
    /** The text box's own name: "Add variable name". */
    inputLabel: string;
    placeholder?: string;
    id?: string | null;
    inputWidth?: number;
    invalid?: boolean;
    describedBy?: string | null;
    transform?: ((text: string) => string) | null;
  }>(),
  {
    placeholder: '',
    id: null,
    inputWidth: 140,
    invalid: false,
    describedBy: null,
    transform: null,
  },
);
const model = defineModel<string[]>({ required: true });

const text = ref('');
const input = ref<HTMLInputElement | null>(null);

/** A press on the box itself (not a chip, not the text box): type into the text box. */
function focusInput(): void {
  input.value?.focus();
}

function add(): void {
  const raw = text.value.trim();
  text.value = '';
  if (!raw) return;
  const names = raw
    .split(/[,\s]+/)
    .map((n) => (props.transform ? props.transform(n) : n))
    .filter((n) => n !== '' && !model.value.includes(n));
  if (names.length) model.value = [...model.value, ...new Set(names)];
}
function remove(name: string): void {
  model.value = model.value.filter((n) => n !== name);
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    add();
  } else if (event.key === 'Backspace' && text.value === '' && model.value.length) {
    model.value = model.value.slice(0, -1);
  }
}
</script>

<template>
  <div
    class="flex min-h-32 cursor-text flex-wrap items-center gap-6 rounded-4 border bg-surface px-6 py-4 focus-within:border-accent"
    :class="invalid ? 'border-fail' : 'border-border-strong'"
    role="group"
    :aria-label="label"
    data-testid="chip-list"
    @mousedown.self.prevent="focusInput"
  >
    <span
      v-for="name in model"
      :key="name"
      class="inline-flex h-22 items-center gap-4 rounded-3 border border-border bg-surface-2 pr-4 pl-8 font-mono text-12"
      data-testid="chip"
      >{{ name
      }}<button
        type="button"
        class="cursor-pointer border-0 bg-transparent px-2 text-text-3 hover:text-text"
        :aria-label="`Remove ${name}`"
        @click="remove(name)"
      >
        ×
      </button></span
    >
    <input
      :id="id ?? undefined"
      ref="input"
      v-model="text"
      class="min-w-0 flex-1 border-0 bg-transparent font-mono text-12 outline-0"
      :style="{ maxWidth: `${inputWidth}px`, minWidth: `${Math.min(inputWidth, 80)}px` }"
      :aria-label="inputLabel"
      :placeholder="placeholder"
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="describedBy ?? undefined"
      autocomplete="off"
      spellcheck="false"
      @keydown="onKeydown"
      @blur="add"
    />
  </div>
</template>

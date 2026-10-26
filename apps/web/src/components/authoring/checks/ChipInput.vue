<script setup lang="ts">
import { ref } from 'vue';

/**
 * A list of short values as chips with a free text input (SA.7, `.ck-chipin`): phrases a
 * text must contain, required columns, keys to ignore. Enter or a comma adds what is typed;
 * Backspace in the empty input removes the last chip; × removes one.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string[];
    placeholder: string;
    label: string;
    invalid?: boolean;
    readonly?: boolean;
    id?: string | null;
  }>(),
  { invalid: false, readonly: false, id: null },
);
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();
const draft = ref('');

function add(): void {
  const value = draft.value.trim();
  draft.value = '';
  if (value && !props.modelValue.includes(value))
    emit('update:modelValue', [...props.modelValue, value]);
}

function remove(index: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index),
  );
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    add();
  } else if (event.key === 'Backspace' && draft.value === '' && props.modelValue.length > 0) {
    remove(props.modelValue.length - 1);
  }
}
</script>

<template>
  <div
    class="flex min-h-32 flex-wrap items-center gap-6 rounded-4 border bg-surface px-6 py-4"
    :class="invalid ? 'border-err shadow-[0_0_0_1px_var(--err)]' : 'border-border-strong'"
    data-testid="chip-input"
  >
    <span
      v-for="(value, i) in modelValue"
      :key="value"
      class="inline-flex h-22 items-center gap-4 rounded-3 border border-border bg-surface-2 pr-2 pl-8 font-mono text-12"
      >{{ value
      }}<button
        v-if="!readonly"
        type="button"
        class="inline-flex size-18 items-center justify-center rounded-3 text-text-3 hover:bg-surface-3 hover:text-text"
        :aria-label="`Remove ${value}`"
        :title="`Remove ${value}`"
        @click="remove(i)"
      >
        ×
      </button></span
    >
    <input
      v-if="!readonly"
      :id="id ?? undefined"
      v-model="draft"
      class="min-w-80 flex-1 border-0 bg-transparent font-mono text-12 outline-none placeholder:text-text-3"
      :placeholder="placeholder"
      :aria-label="label"
      :aria-invalid="invalid ? 'true' : undefined"
      @keydown="onKeydown"
      @blur="add"
    />
  </div>
</template>

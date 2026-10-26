<script setup lang="ts">
import { ref, watch } from 'vue';
import type { JsonValue } from '@hermes-evals/shared';

/**
 * A number setting typed as text (Absolute tolerance, Share of keys, Timeout): what is typed
 * stays on screen ("0." while typing 0.8), and the card gets a number when it reads as one,
 * the text otherwise (the API reports it), or nothing when it is empty, which brings the
 * default back once the field loses focus.
 */
const props = withDefaults(
  defineProps<{
    modelValue: JsonValue | undefined;
    id?: string | null;
    placeholder?: string | null;
    invalid?: boolean;
    readonly?: boolean;
    describedBy?: string | null;
    ariaLabel?: string | null;
  }>(),
  {
    id: null,
    placeholder: null,
    invalid: false,
    readonly: false,
    describedBy: null,
    ariaLabel: null,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: JsonValue | undefined] }>();

const shown = (v: JsonValue | undefined): string =>
  v === undefined || v === null ? '' : String(v);
const text = ref(shown(props.modelValue));
const focused = ref(false);
// While the field has focus it shows what is typed; a default shows again on blur.
watch(
  () => props.modelValue,
  (value) => {
    if (!focused.value && parse(text.value) !== value) text.value = shown(value);
  },
);

function onBlur(): void {
  focused.value = false;
  if (parse(text.value) !== props.modelValue) text.value = shown(props.modelValue);
}

function parse(raw: string): JsonValue | undefined {
  const t = raw.trim().replace('−', '-');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) && /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? n : raw;
}

function onInput(event: Event): void {
  text.value = (event.target as HTMLInputElement).value;
  emit('update:modelValue', parse(text.value));
}
</script>

<template>
  <input
    :id="id ?? undefined"
    class="input w-full font-mono text-12"
    inputmode="decimal"
    :value="text"
    :placeholder="placeholder ?? undefined"
    :readonly="readonly"
    :aria-invalid="invalid ? 'true' : undefined"
    :aria-describedby="describedBy ?? undefined"
    :aria-label="ariaLabel ?? undefined"
    :class="invalid ? 'border-err shadow-[0_0_0_1px_var(--err)]' : ''"
    @input="onInput"
    @focus="focused = true"
    @blur="onBlur"
  />
</template>

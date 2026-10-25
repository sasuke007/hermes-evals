<script setup lang="ts" generic="V extends string | number">
import FormField from './FormField.vue';
import type { SelectOption } from './types';

/**
 * A native select in the input style: filters (Runs: Configuration, Task, Run status), the
 * provider field, the comparison's score key. With `label` it sits in a FormField with its
 * help line; without one it needs `ariaLabel` (or a <label for> beside it, with `id`).
 */
withDefaults(
  defineProps<{
    options: SelectOption<V>[];
    label?: string | null;
    ariaLabel?: string | null;
    id?: string | null;
    help?: string | null;
    warning?: string | null;
    error?: string | null;
    /** sm: 30px / 12px (toolbars) · md: 32px. */
    size?: 'sm' | 'md';
    mono?: boolean;
    disabled?: boolean;
    /** CSS width: 200 (px) or '100%'. */
    width?: number | string | null;
  }>(),
  {
    label: null,
    ariaLabel: null,
    id: null,
    help: null,
    warning: null,
    error: null,
    size: 'md',
    mono: false,
    disabled: false,
    width: null,
  },
);
const model = defineModel<V>({ required: true });

const css = (w: number | string | null): string | undefined =>
  w === null ? undefined : typeof w === 'number' ? `${w}px` : w;
</script>

<template>
  <FormField
    v-if="label"
    v-slot="{ id: controlId, describedBy, invalid, warn }"
    :label="label"
    :id="id"
    :help="help"
    :warning="warning"
    :error="error"
  >
    <select
      :id="controlId"
      v-model="model"
      class="input"
      :class="{ sm: size === 'sm', 'font-mono': mono, warn }"
      :style="{ width: css(width) }"
      :disabled="disabled"
      :aria-invalid="invalid"
      :aria-describedby="describedBy"
    >
      <option v-for="o in options" :key="String(o.value)" :value="o.value" :disabled="o.disabled">
        {{ o.label }}
      </option>
    </select>
  </FormField>
  <select
    v-else
    :id="id ?? undefined"
    v-model="model"
    class="input"
    :class="{ sm: size === 'sm', 'font-mono': mono }"
    :style="{ width: css(width) }"
    :disabled="disabled"
    :aria-label="ariaLabel ?? undefined"
  >
    <option v-for="o in options" :key="String(o.value)" :value="o.value" :disabled="o.disabled">
      {{ o.label }}
    </option>
  </select>
</template>

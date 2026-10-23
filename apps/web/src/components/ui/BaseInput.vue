<script setup lang="ts">
import { computed, useId } from 'vue';

/**
 * Label, control and one help line. The help line turns amber for a warning and orange for an
 * error (which also sets aria-invalid); validation runs on blur in the forms that use it.
 */
const props = withDefaults(
  defineProps<{
    label: string;
    id?: string | null;
    type?: string;
    help?: string | null;
    error?: string | null;
    warning?: string | null;
    mono?: boolean;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    /** Renders a textarea. */
    multiline?: boolean;
    rows?: number;
  }>(),
  {
    id: null,
    type: 'text',
    help: null,
    error: null,
    warning: null,
    mono: false,
    placeholder: undefined,
    required: false,
    disabled: false,
    multiline: false,
    rows: 3,
  },
);
const model = defineModel<string | number | null>({ default: '' });
defineEmits<{ blur: [event: FocusEvent] }>();

const autoId = useId();
const inputId = computed(() => props.id ?? `in-${autoId}`);
const helpId = computed(() => `${inputId.value}-help`);
const helpText = computed(() => props.error ?? props.warning ?? props.help);
</script>

<template>
  <div class="field">
    <label :for="inputId">{{ label }}</label>
    <textarea
      v-if="multiline"
      :id="inputId"
      v-model="model"
      class="in"
      :class="{ mono, warn: !error && !!warning }"
      :rows="rows"
      :placeholder="placeholder"
      :required="required"
      :disabled="disabled"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="helpText ? helpId : undefined"
      @blur="$emit('blur', $event)"
    />
    <input
      v-else
      :id="inputId"
      v-model="model"
      class="in"
      :class="{ mono, warn: !error && !!warning }"
      :type="type"
      :placeholder="placeholder"
      :required="required"
      :disabled="disabled"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="helpText ? helpId : undefined"
      @blur="$emit('blur', $event)"
    />
    <span
      v-if="helpText"
      :id="helpId"
      class="help"
      :class="{ error: !!error, warn: !error && !!warning }"
      >{{ helpText }}</span
    >
  </div>
</template>

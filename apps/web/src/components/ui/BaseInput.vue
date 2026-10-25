<script setup lang="ts">
import FormField from './FormField.vue';

/**
 * Label, text input and one help line. The help line turns amber for a warning and orange for
 * an error (which also sets aria-invalid); validation runs on blur in the forms that use it.
 * `multiline` renders a textarea (TextArea is the same with its own defaults).
 */
withDefaults(
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
    /** sm: 30px / 12px (filter bars). */
    size?: 'sm' | 'md';
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
    size: 'md',
  },
);
const model = defineModel<string | number | null>({ default: '' });
defineEmits<{ blur: [event: FocusEvent] }>();
</script>

<template>
  <FormField
    v-slot="{ id: controlId, describedBy, invalid, warn }"
    :label="label"
    :id="id"
    :help="help"
    :warning="warning"
    :error="error"
    :required="required"
  >
    <textarea
      v-if="multiline"
      :id="controlId"
      v-model="model"
      class="input"
      :class="{ 'font-mono': mono, warn }"
      :rows="rows"
      :placeholder="placeholder"
      :required="required"
      :disabled="disabled"
      :aria-invalid="invalid"
      :aria-describedby="describedBy"
      @blur="$emit('blur', $event)"
    />
    <input
      v-else
      :id="controlId"
      v-model="model"
      class="input"
      :class="{ 'font-mono': mono, warn, sm: size === 'sm' }"
      :type="type"
      :placeholder="placeholder"
      :required="required"
      :disabled="disabled"
      :aria-invalid="invalid"
      :aria-describedby="describedBy"
      @blur="$emit('blur', $event)"
    />
  </FormField>
</template>

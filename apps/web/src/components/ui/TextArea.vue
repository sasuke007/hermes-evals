<script setup lang="ts">
import FormField from './FormField.vue';

/**
 * A labelled multi-line input with its help line (New experiment › Description). Grows by
 * dragging; mono for YAML, JSON or prompts.
 */
withDefaults(
  defineProps<{
    label: string;
    id?: string | null;
    rows?: number;
    help?: string | null;
    warning?: string | null;
    error?: string | null;
    placeholder?: string;
    mono?: boolean;
    required?: boolean;
    disabled?: boolean;
  }>(),
  {
    id: null,
    rows: 2,
    help: null,
    warning: null,
    error: null,
    placeholder: undefined,
    mono: false,
    required: false,
    disabled: false,
  },
);
const model = defineModel<string>({ default: '' });
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
      :id="controlId"
      v-model="model"
      class="input"
      :class="{ 'font-mono text-12 leading-18': mono, warn }"
      :rows="rows"
      :placeholder="placeholder"
      :required="required"
      :disabled="disabled"
      :aria-invalid="invalid"
      :aria-describedby="describedBy"
      @blur="$emit('blur', $event)"
    />
  </FormField>
</template>

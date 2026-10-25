<script setup lang="ts">
import { computed, useId } from 'vue';

/**
 * A label, one control and one help line: the form field of every form. The help line turns
 * amber for a warning and orange for an error (Components 1 › Controls). The control comes
 * from the slot, which receives the ids to bind:
 *
 *   <FormField label="Repetitions" :warning="w" v-slot="{ id, describedBy, invalid }">
 *     <input :id="id" class="input font-mono" :aria-describedby="describedBy"
 *       :aria-invalid="invalid" />
 *   </FormField>
 *
 * BaseInput, TextArea and Select are built on it.
 */
const props = withDefaults(
  defineProps<{
    label: string;
    /** The control's id; generated when omitted. */
    id?: string | null;
    help?: string | null;
    warning?: string | null;
    /** Wins over warning and help, and marks the control aria-invalid. */
    error?: string | null;
    /** Draws the red asterisk after the label (New experiment › Name). */
    required?: boolean;
    /** Keeps the label for screen readers only (a control labelled by its row). */
    hideLabel?: boolean;
  }>(),
  {
    id: null,
    help: null,
    warning: null,
    error: null,
    required: false,
    hideLabel: false,
  },
);

const autoId = useId();
const controlId = computed(() => props.id ?? `field-${autoId}`);
const helpId = computed(() => `${controlId.value}-help`);
const helpText = computed(() => props.error ?? props.warning ?? props.help);
const tone = computed(() => (props.error ? 'error' : props.warning ? 'warning' : 'help'));
/** aria-invalid for the control: set only for an error. */
const invalid = computed<'true' | undefined>(() => (props.error ? 'true' : undefined));
</script>

<template>
  <div class="flex flex-col gap-4" :data-tone="tone">
    <label
      :for="controlId"
      class="text-12 leading-20 font-medium text-text-2"
      :class="{ 'sr-only': hideLabel }"
      >{{ label }}<span v-if="required" class="text-fail-text" aria-hidden="true"> *</span></label
    >
    <slot
      :id="controlId"
      :described-by="helpText ? helpId : undefined"
      :invalid="invalid"
      :warn="!error && !!warning"
    />
    <span
      v-if="helpText"
      :id="helpId"
      class="text-12"
      :class="
        tone === 'error' ? 'text-fail-text' : tone === 'warning' ? 'text-ung-text' : 'text-text-3'
      "
      data-testid="field-help"
      >{{ helpText }}</span
    >
  </div>
</template>

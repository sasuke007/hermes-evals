<script setup lang="ts">
import { ref, watch } from 'vue';
import FormField from '@/components/ui/FormField.vue';

/**
 * The board's .stepper: − and + around a mono number input, 32px high (New experiment ›
 * Repetitions and Concurrency). The buttons clamp to min and max; typing anything that is not
 * a whole number sets the model to null, so the form can say what is wrong. At min or max a
 * button is aria-disabled, not disabled, so the one that got there keeps focus; the row clips
 * its corners, so focus rings are drawn inside.
 */
const props = withDefaults(
  defineProps<{
    label: string;
    id?: string | null;
    min?: number;
    max: number;
    /** aria-labels of the buttons: "Fewer repetitions", "More repetitions". */
    decreaseLabel: string;
    increaseLabel: string;
    help?: string | null;
    error?: string | null;
  }>(),
  { id: null, min: 1, help: null, error: null },
);
const model = defineModel<number | null>({ required: true });

const text = ref(model.value === null ? '' : String(model.value));
watch(model, (value) => {
  if (value !== null && String(value) !== text.value.trim()) text.value = String(value);
});

function onInput(event: Event): void {
  text.value = (event.target as HTMLInputElement).value;
  model.value = /^\s*\d+\s*$/.test(text.value) ? Number(text.value) : null;
}

const atMin = () => model.value !== null && model.value <= props.min;
const atMax = () => model.value !== null && model.value >= props.max;

function step(by: number): void {
  if ((by < 0 && atMin()) || (by > 0 && atMax())) return;
  const current = model.value ?? (by > 0 ? props.min - 1 : props.min + 1);
  const next = Math.min(props.max, Math.max(props.min, current + by));
  model.value = next;
  text.value = String(next);
}
</script>

<template>
  <FormField
    v-slot="{ id: controlId, describedBy, invalid }"
    :label="label"
    :id="id"
    :help="help"
    :error="error"
  >
    <div
      class="inline-flex h-32 items-stretch self-start overflow-hidden rounded-4 border bg-surface"
      :class="invalid ? 'border-fail' : 'border-border-strong'"
      data-testid="stepper"
    >
      <button
        type="button"
        class="w-32 border-0 bg-surface-2 text-15 text-text-2 hover:bg-surface-3 focus-visible:relative focus-visible:z-1 focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-surface-2"
        :aria-label="decreaseLabel"
        :aria-disabled="atMin() || undefined"
        @click="step(-1)"
      >
        −
      </button>
      <input
        :id="controlId"
        :value="text"
        class="w-64 border-0 border-x border-border-strong bg-surface text-center font-mono focus-visible:relative focus-visible:z-1 focus-visible:-outline-offset-2"
        inputmode="numeric"
        :aria-invalid="invalid"
        :aria-describedby="describedBy"
        @input="onInput"
      />
      <button
        type="button"
        class="w-32 border-0 bg-surface-2 text-15 text-text-2 hover:bg-surface-3 focus-visible:relative focus-visible:z-1 focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-surface-2"
        :aria-label="increaseLabel"
        :aria-disabled="atMax() || undefined"
        @click="step(1)"
      >
        +
      </button>
    </div>
  </FormField>
</template>

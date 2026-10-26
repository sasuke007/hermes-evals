<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import CodeTextArea from './CodeTextArea.vue';
import CodeText from './CodeText.vue';
import EditorNote from './EditorNote.vue';
import { jsonProblem } from './editorText';

/**
 * A JSON text with line numbers (Components 5, JsonEditor): reference.json, a JSON Schema,
 * a tool's arguments. Invalid JSON is kept as typed (the API stores it and reports it, plan
 * 4.6): the bad character is underlined at its column, marked in the gutter and stated
 * below ("Not valid JSON: line 1, col 21: expected `,` or `}`."). Read-only shows
 * "Read-only." under it.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    readonly?: boolean;
    placeholder?: string;
    id?: string | null;
    /** Draws an empty text as an error too (a field that must hold JSON). */
    required?: boolean;
  }>(),
  {
    readonly: false,
    placeholder: 'Type or paste the known-good answer: any JSON value.',
    id: null,
    required: false,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const focused = ref(false);
const area = ref<InstanceType<typeof CodeTextArea> | null>(null);
const errorId = `json-error-${useId()}`;
const problem = computed(() => jsonProblem(props.modelValue));

defineExpose({ focus: () => area.value?.focus(), problem });
</script>

<template>
  <div class="flex w-full flex-col gap-6">
    <div
      class="overflow-hidden rounded-4 border"
      :class="[
        focused && !readonly
          ? 'border-focus shadow-[0_0_0_1px_var(--focus)]'
          : 'border-border-strong',
        readonly ? 'bg-surface-2' : 'bg-surface',
      ]"
      data-testid="json-editor"
    >
      <CodeTextArea
        :id="id"
        ref="area"
        :model-value="modelValue"
        :label="label"
        :readonly="readonly"
        :placeholder="placeholder"
        :error-line="problem?.line ?? null"
        :error-column="problem?.column ?? null"
        :error-length="1"
        :min-height="modelValue === '' ? 72 : 0"
        :invalid="!!problem"
        :described-by="problem ? errorId : null"
        @update:model-value="emit('update:modelValue', $event)"
        @focus="focused = true"
        @blur="focused = false"
      />
    </div>
    <EditorNote v-if="problem" :id="errorId" tone="problem" alert data-testid="json-error">
      <template #lead
        >Not valid JSON: line {{ problem.line }}, col {{ problem.column }}:
        <CodeText :text="`${problem.message}.`"
      /></template>
    </EditorNote>
    <span v-if="readonly" class="text-12 text-text-3">Read-only.</span>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import type { JsonValue } from '@hermes-evals/shared';
import ZoneLabel from '@/components/suites/ZoneLabel.vue';
import MarkdownEditor from '../editors/MarkdownEditor.vue';
import FieldBox from './FieldBox.vue';
import KeyField from './KeyField.vue';
import NumberField from './NumberField.vue';
import { asString, withParam, type Params } from './params';

/**
 * The settings of a Rubric judge (SA.7): the rubric, saved as its own file in the task folder
 * and hidden from the agent (only the judge reads it), the key, the pass threshold and an
 * optional judge model. Nothing calls a model while you author. The model is a text field
 * ("Platform default" when empty): the boards draw a select whose options no contract lists.
 */
const props = withDefaults(
  defineProps<{
    checkKey: string;
    keyError?: string | null;
    params: Params;
    errors: Record<string, string>;
    rubric: string;
    readonly?: boolean;
  }>(),
  { keyError: null, readonly: false },
);
const emit = defineEmits<{
  params: [value: Params];
  key: [value: string];
  rubric: [text: string];
}>();
const ids = useId();
const set = (name: string, value: JsonValue | undefined) =>
  emit('params', withParam(props.params, name, value));
const err = (name: string) => props.errors[name] ?? null;
</script>

<template>
  <div class="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-16 max-lg:grid-cols-1">
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex items-center justify-between gap-8">
        <span class="text-12 font-medium text-text-2"
          >Rubric · saved as <code>{{ asString(params.rubric) || 'rubric.md' }}</code></span
        >
        <span class="inline-flex items-center gap-6"
          ><ZoneLabel zone="hidden" /><span class="text-12 text-text-3">the judge only</span></span
        >
      </div>
      <MarkdownEditor
        :model-value="rubric"
        label="Rubric"
        placeholder="Score 1 when the reply …"
        :readonly="readonly"
        :readonly-note="null"
        @update:model-value="emit('rubric', $event)"
      />
      <span v-if="err('rubric')" role="alert" class="text-12 text-err-text">{{
        err('rubric')
      }}</span>
    </div>
    <div class="flex flex-col gap-12">
      <KeyField
        :model-value="checkKey"
        :error="keyError"
        :readonly="readonly"
        @update:model-value="emit('key', $event)"
      />
      <FieldBox
        label="Pass threshold"
        :for="`${ids}-pass`"
        help="0 to 1 · default 0.7"
        :error="err('pass_at')"
      >
        <NumberField
          :id="`${ids}-pass`"
          :model-value="params.pass_at ?? 0.7"
          :invalid="!!err('pass_at')"
          :readonly="readonly"
          @update:model-value="set('pass_at', $event)"
        />
      </FieldBox>
      <FieldBox label="Judge model" :for="`${ids}-model`" help="Optional" :error="err('model')">
        <input
          :id="`${ids}-model`"
          class="input w-full font-mono text-12"
          :value="asString(params.model)"
          placeholder="Platform default"
          :readonly="readonly"
          spellcheck="false"
          @input="set('model', ($event.target as HTMLInputElement).value || undefined)"
        />
      </FieldBox>
    </div>
  </div>
</template>

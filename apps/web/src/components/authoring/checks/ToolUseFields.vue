<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { TRAJECTORY_MODES, type JsonValue } from '@hermes-evals/shared';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import SegmentedControl from '@/components/ui/SegmentedControl.vue';
import JsonEditor from '../editors/JsonEditor.vue';
import FieldBox from './FieldBox.vue';
import KeyField from './KeyField.vue';
import NumberField from './NumberField.vue';
import { asString, withParam, type Params } from './params';

/**
 * The settings of a Tool use check (SA.7): the tool, the arguments a call must hold (a
 * subset match), how often, and the Advanced whole-trajectory mode. It can only be checked
 * on a real run.
 */
const props = withDefaults(
  defineProps<{
    checkKey: string;
    keyError?: string | null;
    params: Params;
    errors: Record<string, string>;
    readonly?: boolean;
  }>(),
  { keyError: null, readonly: false },
);
const emit = defineEmits<{ params: [value: Params]; key: [value: string] }>();
const ids = useId();
const set = (name: string, value: JsonValue | undefined) =>
  emit('params', withParam(props.params, name, value));
const err = (name: string) => props.errors[name] ?? null;

const argsText = ref(props.params.args === undefined ? '' : JSON.stringify(props.params.args));
watch(
  () => props.params.args,
  (args) => {
    try {
      if (
        argsText.value.trim() !== '' &&
        JSON.stringify(JSON.parse(argsText.value)) === JSON.stringify(args)
      )
        return;
    } catch {
      return;
    }
    argsText.value = args === undefined ? '' : JSON.stringify(args);
  },
);
function editArgs(text: string): void {
  argsText.value = text;
  if (text.trim() === '') return set('args', undefined);
  try {
    set('args', JSON.parse(text) as JsonValue);
  } catch {
    /* kept as typed; the editor marks where it stops being JSON */
  }
}

const whole = ref(typeof props.params.mode === 'string');
function setWhole(on: boolean): void {
  whole.value = on;
  set('mode', on ? asString(props.params.mode) || 'strict' : undefined);
}
</script>

<template>
  <div class="flex flex-col gap-14">
    <div class="grid grid-cols-3 items-start gap-x-16 gap-y-12 max-lg:grid-cols-2">
      <KeyField
        :model-value="checkKey"
        :error="keyError"
        :readonly="readonly"
        @update:model-value="emit('key', $event)"
      />
      <FieldBox
        label="Tool"
        :for="`${ids}-tool`"
        help="Suggestions: `read_file`, `terminal`, `mcp_invoice_db_query`"
        :error="err('tool')"
      >
        <input
          :id="`${ids}-tool`"
          class="input w-full font-mono text-12"
          :value="asString(params.tool)"
          placeholder="read_file"
          :readonly="readonly"
          spellcheck="false"
          @input="set('tool', ($event.target as HTMLInputElement).value || undefined)"
        />
      </FieldBox>
      <div class="grid grid-cols-2 gap-12">
        <FieldBox label="Min calls" :for="`${ids}-min`" help="Default 1">
          <NumberField
            :id="`${ids}-min`"
            :model-value="params.min_calls ?? 1"
            :invalid="!!err('min_calls')"
            :readonly="readonly"
            @update:model-value="set('min_calls', $event)"
          />
        </FieldBox>
        <FieldBox label="Max calls" :for="`${ids}-max`" help="Optional">
          <NumberField
            :id="`${ids}-max`"
            :model-value="params.max_calls"
            :invalid="!!err('max_calls')"
            :readonly="readonly"
            @update:model-value="set('max_calls', $event)"
          />
        </FieldBox>
      </div>
    </div>
    <span v-if="err('max_calls')" role="alert" class="text-12 text-err-text">{{
      err('max_calls')
    }}</span>
    <FieldBox
      label="Arguments to match"
      help="Subset match: the call needs these arguments and may have others."
      :error="err('args')"
    >
      <JsonEditor
        :model-value="argsText"
        label="Arguments to match"
        placeholder='{ "path": "invoices.csv" }'
        :readonly="readonly"
        @update:model-value="editArgs"
      />
    </FieldBox>
    <div
      class="flex flex-wrap items-center justify-between gap-10 rounded-4 border border-border px-10 py-8"
    >
      <span class="inline-flex flex-wrap items-center gap-8">
        <b class="text-12">Advanced</b>
        <BaseToggle
          :model-value="whole"
          label="Compare the whole trajectory"
          :disabled="readonly"
          @update:model-value="setWhole"
        />
        <SegmentedControl
          v-if="whole"
          :model-value="asString(params.mode) || 'strict'"
          :options="TRAJECTORY_MODES.map((m) => ({ value: m, label: m }))"
          label="Trajectory mode"
          @update:model-value="set('mode', $event)"
        />
      </span>
      <span class="text-12 text-text-3"
        >mode strict · unordered · subset · superset, instead of counting calls</span
      >
    </div>
  </div>
</template>

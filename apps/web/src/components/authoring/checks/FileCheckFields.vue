<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { JsonValue } from '@hermes-evals/shared';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import SegmentedControl from '@/components/ui/SegmentedControl.vue';
import JsonEditor from '../editors/JsonEditor.vue';
import ChipInput from './ChipInput.vue';
import FieldBox from './FieldBox.vue';
import KeyField from './KeyField.vue';
import NumberField from './NumberField.vue';
import { asList, asString, withParam, type Params } from './params';

/**
 * The settings of a File check (SA.7): the file the agent leaves, its format, whether it
 * must exist, and what it must hold. Format csv unlocks required columns and row count; for
 * json a JSON Schema editor takes their place. Where the file is collected from (the
 * workspace, or the home's `memories/`, Phase 6) is a choice the boards do not draw: it is
 * shown as "Collected from", Workspace · Home.
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

const root = computed<'workspace' | 'home'>(() =>
  props.params.root === 'home' ? 'home' : 'workspace',
);
const format = computed(() => asString(props.params.format) || 'none');
const where = computed(() => {
  const path = asString(props.params.path);
  if (!path) return null;
  return root.value === 'home'
    ? `As the agent leaves it: \`~/${path}\``
    : `As the agent leaves it: \`/workspace/${path}\``;
});
const showSchema = computed(
  () => format.value === 'json' || props.params.json_schema !== undefined,
);
const csvError = computed(() => err('columns') ?? err('row_count'));

const schemaText = ref(JSON.stringify(props.params.json_schema ?? {}, null, 2));
watch(
  () => props.params.json_schema,
  (schema) => {
    try {
      if (JSON.stringify(JSON.parse(schemaText.value)) === JSON.stringify(schema ?? {})) return;
    } catch {
      return;
    }
    schemaText.value = JSON.stringify(schema ?? {}, null, 2);
  },
);
function editSchema(text: string): void {
  schemaText.value = text;
  try {
    const value = JSON.parse(text) as JsonValue;
    set('json_schema', text.trim() === '' ? undefined : value);
  } catch {
    /* kept as typed; the editor marks where it stops being JSON */
  }
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
        :label="root === 'home' ? 'File path in the home' : 'File path in the workspace'"
        :for="`${ids}-path`"
        :help="where"
        :error="err('path')"
      >
        <input
          :id="`${ids}-path`"
          class="input w-full font-mono text-12"
          :value="asString(params.path)"
          :placeholder="root === 'home' ? 'memories/USER.md' : 'summary.csv'"
          :readonly="readonly"
          spellcheck="false"
          data-field="path"
          @input="set('path', ($event.target as HTMLInputElement).value)"
        />
      </FieldBox>
      <FieldBox label="Format" :error="err('format')">
        <SegmentedControl
          class="self-start"
          :model-value="format"
          :options="[
            { value: 'none', label: 'none' },
            { value: 'csv', label: 'csv' },
            { value: 'json', label: 'json' },
            { value: 'text', label: 'text' },
          ]"
          label="Format"
          @update:model-value="set('format', $event === 'none' ? undefined : $event)"
        />
      </FieldBox>
    </div>
    <div class="flex flex-wrap items-center gap-x-28 gap-y-12">
      <BaseToggle
        :model-value="params.must_exist !== false"
        label="Must exist"
        :disabled="readonly"
        @update:model-value="set('must_exist', $event ? undefined : false)"
      />
      <div class="flex items-center gap-8">
        <span class="text-12 font-medium text-text-2">Collected from</span>
        <SegmentedControl
          :model-value="root"
          :options="[
            { value: 'workspace', label: 'Workspace' },
            { value: 'home', label: 'Home' },
          ]"
          label="Collected from"
          @update:model-value="set('root', $event === 'home' ? 'home' : undefined)"
        />
      </div>
    </div>
    <div
      v-if="!showSchema || format === 'csv'"
      class="flex flex-wrap items-start gap-x-28 gap-y-16"
    >
      <div class="min-w-320">
        <FieldBox label="Required columns">
          <ChipInput
            :model-value="asList(params.columns)"
            placeholder="Add column"
            label="Add a required column"
            :invalid="!!err('columns')"
            :readonly="readonly"
            @update:model-value="set('columns', $event.length ? $event : undefined)"
          />
        </FieldBox>
      </div>
      <div class="w-140">
        <FieldBox label="Row count" :for="`${ids}-rows`" help="Data rows, without the header">
          <NumberField
            :id="`${ids}-rows`"
            :model-value="params.row_count"
            :invalid="!!err('row_count')"
            :readonly="readonly"
            @update:model-value="set('row_count', $event)"
          />
        </FieldBox>
      </div>
      <div class="min-w-220">
        <FieldBox label="Must contain" :error="err('contains')">
          <ChipInput
            :model-value="asList(params.contains)"
            placeholder="Add text"
            label="Add text the file must contain"
            :readonly="readonly"
            @update:model-value="set('contains', $event.length ? $event : undefined)"
          />
        </FieldBox>
      </div>
    </div>
    <span v-if="csvError" role="alert" class="text-12 text-err-text">{{ csvError }}</span>
    <FieldBox v-if="showSchema" label="JSON Schema" :error="err('json_schema')">
      <JsonEditor
        :model-value="schemaText"
        label="JSON Schema"
        placeholder="{ }"
        :readonly="readonly"
        @update:model-value="editSchema"
      />
    </FieldBox>
    <span v-else class="text-12 text-text-3"
      >For format json, a JSON Schema editor replaces columns and row count.</span
    >
  </div>
</template>

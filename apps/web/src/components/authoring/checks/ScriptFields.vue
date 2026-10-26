<script setup lang="ts">
import { computed, useId } from 'vue';
import type { JsonValue } from '@hermes-evals/shared';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import FieldBox from './FieldBox.vue';
import KeyField from './KeyField.vue';
import NumberField from './NumberField.vue';
import ScriptSource from './ScriptSource.vue';
import { asString, withParam, type Params } from './params';

/**
 * The settings of a Verifier script (SA.7): the key, the script among the task's `verify/`
 * files, its timeout and pass threshold, which are part of task.yaml and so editable here;
 * the script itself is shown read-only with its path, size and hash. Scripts are code and
 * are edited on disk (plan 4.6, V6).
 */
const props = withDefaults(
  defineProps<{
    checkKey: string;
    keyError?: string | null;
    params: Params;
    errors: Record<string, string>;
    /** The task's verify/ files: `verify/check_summary.py`, with size and hash. */
    scripts: Array<{ path: string; sizeBytes: number; sha256: string }>;
    /** The chosen script's source, once read; null while it loads. */
    source: string | null;
    sourceError?: string | null;
    readonly?: boolean;
  }>(),
  { keyError: null, sourceError: null, readonly: false },
);
const emit = defineEmits<{ params: [value: Params]; key: [value: string] }>();
const ids = useId();
const set = (name: string, value: JsonValue | undefined) =>
  emit('params', withParam(props.params, name, value));
const err = (name: string) => props.errors[name] ?? null;

const scriptName = computed(() => asString(props.params.script));
const file = computed(
  () => props.scripts.find((s) => s.path === `verify/${scriptName.value}`) ?? null,
);
const options = computed(() => {
  const names = props.scripts.map((s) => s.path.replace(/^verify\//i, ''));
  if (scriptName.value && !names.includes(scriptName.value)) names.unshift(scriptName.value);
  return names.map((n) => ({ value: n, label: n }));
});
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
        label="Script"
        :for="`${ids}-script`"
        help="Files under `verify/`"
        :error="err('script')"
      >
        <BaseSelect
          :id="`${ids}-script`"
          :model-value="scriptName"
          :options="options"
          mono
          :disabled="readonly || options.length === 0"
          @update:model-value="set('script', $event)"
        />
      </FieldBox>
      <div class="grid grid-cols-2 gap-12">
        <FieldBox
          label="Timeout (s)"
          :for="`${ids}-timeout`"
          help="1 to 300 · default 30"
          :error="err('timeout_s')"
        >
          <NumberField
            :id="`${ids}-timeout`"
            :model-value="params.timeout_s ?? 30"
            :invalid="!!err('timeout_s')"
            :readonly="readonly"
            @update:model-value="set('timeout_s', $event)"
          />
        </FieldBox>
        <FieldBox label="Pass threshold" :for="`${ids}-pass`" help="0 to 1" :error="err('pass_at')">
          <NumberField
            :id="`${ids}-pass`"
            :model-value="params.pass_at ?? 1"
            :invalid="!!err('pass_at')"
            :readonly="readonly"
            @update:model-value="set('pass_at', $event)"
          />
        </FieldBox>
      </div>
    </div>
    <ScriptSource v-if="file" :file="file" :source="source" :error="sourceError" />
    <span class="text-12 text-text-3"
      >The script runs in the platform's worker, outside any run: in the self-check (against the
      reference and the expected workspace) and when each run is scored. Its score is 0 to 1; it
      passes at the threshold above. The settings are part of <code>task.yaml</code>.</span
    >
  </div>
</template>

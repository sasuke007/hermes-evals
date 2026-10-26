<script setup lang="ts">
import { computed, useId } from 'vue';
import type { JsonValue, ScorerType } from '@hermes-evals/shared';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import ChipInput from './ChipInput.vue';
import FieldBox from './FieldBox.vue';
import KeyField from './KeyField.vue';
import NumberField from './NumberField.vue';
import { asList, asString, withParam, type Params } from './params';

/**
 * The settings of the four answer checks (SA.7): Number within tolerance (path, absolute
 * and relative tolerance), JSON match (path, share of keys, list order, keys to ignore),
 * Exact text (path, trim, case) and Text match (path, phrases, pattern, case, share). A
 * primary check with no path of its own reads the answer path, which its Path field shows
 * as "inherits overdue_count".
 */
const props = withDefaults(
  defineProps<{
    type: ScorerType;
    checkKey: string;
    keyError?: string | null;
    params: Params;
    errors: Record<string, string>;
    primary: boolean;
    /** The answer path a primary check inherits, or null. */
    answerPath: string | null;
    readonly?: boolean;
  }>(),
  { keyError: null, readonly: false },
);
const emit = defineEmits<{ params: [value: Params]; key: [value: string] }>();

const ids = useId();

const inherits = computed(() => (props.primary && props.answerPath ? props.answerPath : null));
const pathPlaceholder = computed(() =>
  inherits.value ? `inherits ${inherits.value}` : 'the whole answer',
);
const pathHelp = computed(() => {
  if (props.type === 'text_match')
    return 'A string value. Any other value is compared as its JSON text.';
  return props.primary ? 'Primary check: empty means it reads the answer path.' : null;
});

function set(name: string, value: JsonValue | undefined): void {
  emit('params', withParam(props.params, name, value));
}
const setText = (name: string, value: string) => set(name, value === '' ? undefined : value);
const bool = (name: string, fallback: boolean) => {
  const v = props.params[name];
  return typeof v === 'boolean' ? v : fallback;
};
const err = (name: string) => props.errors[name] ?? null;
const cols = computed(() => (props.type === 'numeric_tolerance' ? 'grid-cols-4' : 'grid-cols-3'));
</script>

<template>
  <div class="flex flex-col gap-14">
    <div class="grid items-start gap-x-16 gap-y-12 max-lg:grid-cols-2" :class="cols">
      <KeyField
        :model-value="checkKey"
        :error="keyError"
        :readonly="readonly"
        @update:model-value="emit('key', $event)"
      />
      <FieldBox label="Path" :for="`${ids}-path`" :help="pathHelp" :error="err('path')">
        <input
          :id="`${ids}-path`"
          class="input w-full font-mono text-12"
          :value="asString(params.path)"
          :placeholder="pathPlaceholder"
          :readonly="readonly"
          spellcheck="false"
          data-field="path"
          @input="setText('path', ($event.target as HTMLInputElement).value)"
        />
      </FieldBox>
      <template v-if="type === 'numeric_tolerance'">
        <FieldBox label="Absolute tolerance" :for="`${ids}-abs`" help="≥ 0" :error="err('abs')">
          <NumberField
            :id="`${ids}-abs`"
            :model-value="params.abs"
            :invalid="!!err('abs')"
            :readonly="readonly"
            @update:model-value="set('abs', $event)"
          />
        </FieldBox>
        <FieldBox
          label="Relative tolerance"
          :for="`${ids}-rel`"
          help="A fraction: 0.01 = 1%"
          :error="err('rel')"
        >
          <NumberField
            :id="`${ids}-rel`"
            :model-value="params.rel"
            placeholder="e.g. 0.01"
            :invalid="!!err('rel')"
            :readonly="readonly"
            @update:model-value="set('rel', $event)"
          />
        </FieldBox>
      </template>
      <FieldBox
        v-else-if="type === 'json_match'"
        label="Share of keys that must match"
        :for="`${ids}-share`"
        help="The score is the share of keys that match: 4 of 5 is 0.80. 1 means every key must match."
        :error="err('pass_at')"
      >
        <NumberField
          :id="`${ids}-share`"
          :model-value="params.pass_at ?? 1"
          :invalid="!!err('pass_at')"
          :readonly="readonly"
          @update:model-value="set('pass_at', $event)"
        />
      </FieldBox>
      <FieldBox
        v-else-if="type === 'text_match'"
        label="Share that must be found"
        :for="`${ids}-share`"
        help="Phrases and the pattern each count once. 1 means all of them."
        :error="err('pass_at')"
      >
        <NumberField
          :id="`${ids}-share`"
          :model-value="params.pass_at ?? 1"
          :invalid="!!err('pass_at')"
          :readonly="readonly"
          @update:model-value="set('pass_at', $event)"
        />
      </FieldBox>
      <div v-else />
    </div>

    <div v-if="type === 'json_match'" class="flex flex-wrap items-center gap-x-28 gap-y-16">
      <BaseToggle
        :model-value="bool('unordered', false)"
        label="Ignore list order"
        :disabled="readonly"
        @update:model-value="set('unordered', $event || undefined)"
      />
      <BaseToggle
        :model-value="bool('inner_unordered', false)"
        label="Ignore order in nested lists"
        :disabled="readonly"
        @update:model-value="set('inner_unordered', $event || undefined)"
      />
      <div class="min-w-300">
        <FieldBox label="Keys to ignore" :error="err('exclude_keys')">
          <ChipInput
            :model-value="asList(params.exclude_keys)"
            placeholder="Add key"
            label="Add a key to ignore"
            :readonly="readonly"
            @update:model-value="set('exclude_keys', $event.length ? $event : undefined)"
          />
        </FieldBox>
      </div>
    </div>

    <div v-else-if="type === 'exact_match'" class="flex flex-wrap items-center gap-x-28 gap-y-16">
      <BaseToggle
        :model-value="bool('trim', true)"
        label="Trim whitespace"
        :disabled="readonly"
        @update:model-value="set('trim', $event ? undefined : false)"
      />
      <BaseToggle
        :model-value="bool('case_sensitive', true)"
        label="Case-sensitive"
        :disabled="readonly"
        @update:model-value="set('case_sensitive', $event ? undefined : false)"
      />
    </div>

    <template v-else-if="type === 'text_match'">
      <div class="grid grid-cols-2 items-start gap-16 max-lg:grid-cols-1">
        <FieldBox label="Must contain" help="Each phrase counts once." :error="err('contains')">
          <ChipInput
            :model-value="asList(params.contains)"
            placeholder="Add phrase"
            label="Add a phrase"
            :invalid="!!err('contains')"
            :readonly="readonly"
            @update:model-value="set('contains', $event.length ? $event : undefined)"
          />
        </FieldBox>
        <FieldBox
          label="Pattern"
          optional
          :for="`${ids}-pattern`"
          help="A regular expression found anywhere in the text. Counts once."
          :error="err('pattern')"
        >
          <input
            :id="`${ids}-pattern`"
            class="input w-full font-mono text-12"
            :class="err('pattern') ? 'border-err shadow-[0_0_0_1px_var(--err)]' : ''"
            :value="asString(params.pattern)"
            placeholder="e.g. \d+ days"
            :readonly="readonly"
            spellcheck="false"
            @input="setText('pattern', ($event.target as HTMLInputElement).value)"
          />
        </FieldBox>
      </div>
      <div class="flex flex-wrap items-center gap-8">
        <BaseToggle
          :model-value="bool('case_sensitive', false)"
          label="Case-sensitive"
          :disabled="readonly"
          @update:model-value="set('case_sensitive', $event || undefined)"
        />
        <span class="text-12 text-text-3">Off by default. Applies to phrases and the pattern.</span>
      </div>
    </template>
  </div>
</template>

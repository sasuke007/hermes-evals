<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { VerificationKeySchema } from '@hermes-evals/shared';
import FieldBox from './FieldBox.vue';

/**
 * A check's key (SA.7): the first field of every card. A key that breaks the key rule is
 * said at once ("Check keys use lowercase letters, digits and `_`, starting with a
 * letter."); the API's message (two checks named `answer`) shows otherwise.
 */
const props = withDefaults(
  defineProps<{ modelValue: string; error?: string | null; readonly?: boolean }>(),
  { error: null, readonly: false },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = `ck-key-${useId()}`;
const input = ref<HTMLInputElement | null>(null);

const local = computed(() => {
  const parsed = VerificationKeySchema.safeParse(props.modelValue);
  if (parsed.success) return null;
  const custom = parsed.error.issues.find((i) => i.code === 'custom');
  return custom
    ? custom.message
    : 'Check keys use lowercase letters, digits and `_`, starting with a letter.';
});
const message = computed(() => local.value ?? props.error);

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <FieldBox label="Key" :for="id" :error="message" :error-id="`${id}-err`">
    <input
      :id="id"
      ref="input"
      class="input w-full font-mono text-12"
      :class="message ? 'border-err shadow-[0_0_0_1px_var(--err)]' : ''"
      :value="modelValue"
      :readonly="readonly"
      :aria-invalid="message ? 'true' : undefined"
      :aria-describedby="message ? `${id}-err` : undefined"
      spellcheck="false"
      data-field="key"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </FieldBox>
</template>

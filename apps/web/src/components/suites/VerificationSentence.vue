<script setup lang="ts">
import { computed } from 'vue';
import type { VerificationEntryView } from '@/api/types/suites';
import { sentenceSegments } from './verificationSentence';

/**
 * One verification entry as a sentence (TaskDetail board, plan 12.2 item 9): the API's
 * sentence, with the check type in mono and the values it names (paths, files, tools,
 * phrases, patterns) in code, for any of the eight check types.
 */
const props = defineProps<{
  entry: Pick<VerificationEntryView, 'type' | 'params' | 'sentence'>;
}>();

const segments = computed(() => sentenceSegments(props.entry));
</script>

<template>
  <p class="text-14 leading-22" data-testid="verification-sentence">
    <template v-for="(s, i) in segments" :key="i">
      <span v-if="s.kind === 'type'" class="font-mono">{{ s.text }}</span>
      <code
        v-else-if="s.kind === 'value'"
        class="rounded-3 bg-surface-2 px-4 py-1 font-mono text-12"
        data-testid="sentence-value"
        >{{ s.text }}</code
      >
      <template v-else>{{ s.text }}</template>
    </template>
  </p>
</template>

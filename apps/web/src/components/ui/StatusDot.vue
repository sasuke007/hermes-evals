<script setup lang="ts">
import { computed } from 'vue';
import { TONE_CLASSES, type DotMode, type Tone } from '@/lib/statusTones';

/**
 * The status dot of chips, pills and live indicators: solid 6px · hollow 7px ring (not
 * started, not a claim) · pulse (live; reduced motion keeps it solid). Decorative: the word
 * beside it carries the meaning.
 */
const props = withDefaults(defineProps<{ tone: Tone; mode?: DotMode }>(), { mode: 'solid' });

const classes = computed(() => {
  const tone = TONE_CLASSES[props.tone];
  if (props.mode === 'hollow') {
    return ['size-7 rounded-full border-[1.5px] bg-transparent', tone.border];
  }
  return ['size-6 rounded-full', { 'animate-live': props.mode === 'pulse' }, tone.solid];
});
</script>

<template>
  <span
    v-if="mode !== 'none'"
    class="inline-block flex-none"
    :class="classes"
    :data-dot="mode"
    :data-tone="tone"
    aria-hidden="true"
  />
</template>

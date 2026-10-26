<script setup lang="ts">
import { computed } from 'vue';

/**
 * A sentence from the API with `code` in backticks, as the authoring messages write paths,
 * keys and file names ("`../secrets.txt` points outside the suite."): the backticked parts
 * render as <code>, the rest as text. An unmatched backtick stays as typed.
 */
const props = defineProps<{ text: string }>();

const parts = computed(() => {
  const pieces = props.text.split('`');
  if (pieces.length % 2 === 0) return [{ code: false, text: props.text }];
  return pieces.map((text, i) => ({ code: i % 2 === 1, text })).filter((p) => p.text !== '');
});
</script>

<template>
  <span
    ><template v-for="(part, i) in parts" :key="i"
      ><code v-if="part.code">{{ part.text }}</code
      ><template v-else>{{ part.text }}</template></template
    ></span
  >
</template>

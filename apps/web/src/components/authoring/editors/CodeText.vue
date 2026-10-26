<script setup lang="ts">
import { computed } from 'vue';
import { codeSegments } from './editorText';

/**
 * A line of copy with `code` in backticks, as the API and the boards write readiness rows,
 * rule lines and notes ("No value at `overdue` (check `answer`)."): each backticked run is
 * set in <code>, the rest as text.
 */
const props = defineProps<{ text: string }>();
const segments = computed(() => codeSegments(props.text));
</script>

<template>
  <template v-for="(s, i) in segments" :key="i"
    ><code v-if="s.code">{{ s.text }}</code
    ><template v-else>{{ s.text }}</template></template
  >
</template>

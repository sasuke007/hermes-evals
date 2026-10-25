<script setup lang="ts">
import type { Inline } from './markdown';

/** One line of parsed Markdown: text, `code` (mono, 12px) and **bold**. */
defineProps<{ inline: Inline[] }>();
</script>

<template>
  <template v-for="(part, i) in inline" :key="i"
    ><code v-if="part.kind === 'code'">{{ part.text }}</code
    ><b v-else-if="part.kind === 'bold'">{{ part.text }}</b
    ><template v-else>{{ part.text }}</template></template
  >
</template>

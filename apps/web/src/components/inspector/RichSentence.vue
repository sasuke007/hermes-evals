<script setup lang="ts">
import { computed } from 'vue';
import { richText } from './inspectorFormat';

/**
 * A sentence with its keys, tools and paths in mono, as the inspector boards write them:
 * "no `read_file` call on invoices.csv" (backticks mark the code). Text without backticks
 * renders as it is.
 */
const props = defineProps<{ text: string | null | undefined }>();
const parts = computed(() => richText(props.text));
</script>

<template>
  <template v-for="(part, i) in parts" :key="i"
    ><code v-if="part.code" class="font-mono text-12">{{ part.text }}</code
    ><template v-else>{{ part.text }}</template></template
  >
</template>

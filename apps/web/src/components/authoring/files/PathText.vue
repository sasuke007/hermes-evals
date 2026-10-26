<script setup lang="ts">
/**
 * A file path that, in a narrow table cell, wraps after a slash before it
 * wraps anywhere else (the cell carries `wrap-anywhere` for a long name).
 */
defineProps<{ path: string }>();
</script>

<template>
  <template v-for="(part, i) in path.split('/')" :key="i"
    ><template v-if="i > 0">/<wbr /></template>{{ part }}</template
  >
</template>

<script setup lang="ts">
/**
 * A neutral label for versions, hashes, names and counts: "v1 · latest", "b72e810",
 * "json_match", "+4". Mono 11px on --surface-2 (the canvas .tag). `strong` sets it in --text
 * and semibold (a task version beside its key).
 */
withDefaults(
  defineProps<{
    /** false sets it in IBM Plex Sans (a word, not a value). */
    mono?: boolean;
    strong?: boolean;
  }>(),
  { mono: true, strong: false },
);
</script>

<template>
  <span
    class="tag"
    :class="{ 'font-sans': !mono, 'font-semibold text-text': strong }"
    data-testid="tag"
  >
    <slot />
  </span>
</template>

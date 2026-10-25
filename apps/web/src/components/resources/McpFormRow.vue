<script setup lang="ts">
/**
 * One row of the MCP server form (ResourcesMcp board): the field's name and help in a 200px
 * column, the controls beside it; one column below 768px. `for` makes the name a label of
 * one control; without it the name heads a group.
 */
withDefaults(
  defineProps<{ label: string; help?: string | null; for?: string | null; last?: boolean }>(),
  { help: null, for: null, last: false },
);
</script>

<template>
  <div
    class="grid grid-cols-[200px_minmax(0,1fr)] gap-24 px-20 py-16 max-md:grid-cols-1 max-md:gap-8"
    :class="{ 'border-b border-border': !last }"
  >
    <div>
      <label v-if="$props.for" :for="$props.for" class="text-13 font-medium text-text">{{
        label
      }}</label>
      <span v-else class="text-13 font-medium text-text">{{ label }}</span>
      <p v-if="help" class="text-12 text-text-3">{{ help }}</p>
    </div>
    <div class="min-w-0"><slot /></div>
  </div>
</template>

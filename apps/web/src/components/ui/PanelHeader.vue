<script setup lang="ts">
/**
 * The header row of a panel: the heading (15/22, semibold) on the left, a caption or
 * controls on the right, a border under it (ConfigDetail, TaskDetail, OverviewRunning).
 */
withDefaults(
  defineProps<{
    title?: string | null;
    /** id of the heading, for the panel's aria-labelledby. */
    id?: string | null;
    level?: 2 | 3;
    /** The caption on the right, in --text-3: "scored / total". */
    meta?: string | null;
    /** A count after the title, in mono --text-3. */
    count?: string | number | null;
  }>(),
  { title: null, id: null, level: 2, meta: null, count: null },
);
</script>

<template>
  <div class="flex items-center justify-between gap-10 border-b border-border px-16 py-12">
    <component
      :is="`h${level}`"
      :id="id ?? undefined"
      class="flex items-baseline gap-8 text-15 font-semibold"
    >
      <slot>{{ title }}</slot>
      <span
        v-if="count !== null && count !== undefined"
        class="font-mono text-12 font-medium text-text-3"
        >{{ count }}</span
      >
    </component>
    <div v-if="$slots.actions || meta" class="flex items-center gap-8">
      <span v-if="meta" class="text-12 text-text-3">{{ meta }}</span>
      <slot name="actions" />
    </div>
  </div>
</template>

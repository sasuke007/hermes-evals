<script setup lang="ts">
import { computed } from 'vue';

/**
 * The frame of every page under the AppShell: centred, at most 1440px wide, with the boards'
 * gutters (24px from 1280px up, 16px below) and the vertical rhythm of each page kind:
 *   list    padding 24, 16 between blocks (Experiments, Configurations, Suites, Resources)
 *   detail  padding 20 24 48, 16 between blocks (a page with a breadcrumb)
 *   system  padding 24 24 48, 28 between sections (System)
 * `gap` overrides the spacing between blocks (Runs uses 14).
 */
const props = withDefaults(
  defineProps<{
    variant?: 'list' | 'detail' | 'system';
    gap?: 14 | 16 | 28 | null;
  }>(),
  { variant: 'list', gap: null },
);

const PADDING = {
  list: 'p-24',
  detail: 'px-24 pt-20 pb-48',
  system: 'px-24 pt-24 pb-48',
} as const;
const GAP = { 14: 'gap-14', 16: 'gap-16', 28: 'gap-28' } as const;

const classes = computed(() => [
  PADDING[props.variant],
  GAP[props.gap ?? (props.variant === 'system' ? 28 : 16)],
]);
</script>

<template>
  <main class="mx-auto flex w-full max-w-1440 flex-col max-xl:px-16" :class="classes">
    <slot />
  </main>
</template>

<script setup lang="ts">
import { useId } from 'vue';

/**
 * One numbered section of the New experiment form (the board's .panel.sect): a panel with 20px
 * padding, 14px between its parts, headed by the section number in mono and its title, with
 * an optional caption after it (#caption).
 */
defineProps<{ number: number; title: string }>();

const headingId = `ne-section-${useId()}`;
</script>

<template>
  <section
    class="flex flex-col gap-14 rounded-6 border border-border bg-surface p-20"
    :aria-labelledby="headingId"
  >
    <h2 :id="headingId" class="flex flex-wrap items-baseline gap-10 text-15 font-semibold">
      <span class="font-mono text-12 font-medium text-text-3">{{ number }}</span>
      <span>{{ title }}</span>
      <span v-if="$slots.caption" class="text-12 font-normal text-text-3"
        ><slot name="caption"
      /></span>
    </h2>
    <slot />
  </section>
</template>

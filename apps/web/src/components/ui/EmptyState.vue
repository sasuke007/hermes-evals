<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';
import { RouterLink } from 'vue-router';

/**
 * Explains what would be here and offers the one action that creates it. No illustration.
 * Centred inside tables and panels; `align="start"` for the left-aligned variant (the empty
 * experiment list with the model setup steps).
 */
withDefaults(
  defineProps<{
    /** What is missing, in a few words. */
    title: string;
    /** At most two sentences on what this is and how it gets filled. */
    body?: string | null;
    /** The single action, as a primary button link. */
    action?: { label: string; to: RouteLocationRaw } | null;
    align?: 'center' | 'start';
    /** false: no panel border (inside a table body or an existing panel). */
    panel?: boolean;
    /** lg: 17px title (page-level empty state); md: 15px. */
    size?: 'md' | 'lg';
  }>(),
  { body: null, action: null, align: 'center', panel: true, size: 'md' },
);
</script>

<template>
  <div
    class="flex flex-col gap-10"
    :class="[
      align === 'start' ? 'items-start px-28 py-36' : 'items-center px-24 py-40 text-center',
      { 'rounded-6 border border-border bg-surface': panel },
    ]"
    data-testid="empty-state"
  >
    <div class="font-semibold" :class="size === 'lg' ? 'text-17' : 'text-15'">{{ title }}</div>
    <p v-if="body" class="max-w-520 text-text-2">{{ body }}</p>
    <slot />
    <div
      v-if="action || $slots.actions || $slots.action"
      class="mt-6 flex flex-wrap items-center gap-10"
    >
      <slot name="actions">
        <slot name="action">
          <RouterLink v-if="action" class="btn primary" :to="action.to">{{
            action.label
          }}</RouterLink>
        </slot>
      </slot>
    </div>
    <p v-if="$slots.footer" class="mt-8 text-12 text-text-3"><slot name="footer" /></p>
  </div>
</template>

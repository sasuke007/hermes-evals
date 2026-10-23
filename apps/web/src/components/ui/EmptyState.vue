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
  <div class="empty" :class="[`align-${align}`, { panel, lg: size === 'lg' }]">
    <div class="empty-title">{{ title }}</div>
    <p v-if="body" class="t2 empty-body">{{ body }}</p>
    <slot />
    <div v-if="action || $slots.actions || $slots.action" class="empty-actions">
      <slot name="actions">
        <slot name="action">
          <RouterLink v-if="action" class="btn primary" :to="action.to">{{
            action.label
          }}</RouterLink>
        </slot>
      </slot>
    </div>
    <p v-if="$slots.footer" class="cap empty-footer"><slot name="footer" /></p>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 40px 24px;
}
.align-center {
  align-items: center;
  text-align: center;
}
.align-start {
  align-items: flex-start;
  padding: 36px 28px;
}
.empty-title {
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
}
.lg .empty-title {
  font-size: 17px;
  line-height: 24px;
}
.empty-body {
  max-width: 520px;
}
.empty-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 6px;
}
.empty-footer {
  margin-top: 8px;
}
</style>

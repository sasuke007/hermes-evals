<script setup lang="ts">
import { computed, useSlots } from 'vue';
import BaseBreadcrumb from './BaseBreadcrumb.vue';
import type { BreadcrumbItem } from './types';

/**
 * The head of a page, as every board draws it: an optional breadcrumb, the title (20/28,
 * semibold; mono for names such as a configuration or a task key), what follows the title
 * on its line (a count in --text-3, #title-extra for chips and tags), an optional
 * description or #meta line under it, and #actions on the right (the one primary button).
 */
const props = withDefaults(
  defineProps<{
    title: string;
    breadcrumbs?: BreadcrumbItem[] | null;
    /** Names and keys are set in mono. */
    mono?: boolean;
    /** "3 configurations", "12" beside the title, in --text-3. */
    count?: string | number | null;
    /** One sentence under the title, in --text-2 (Resources, System). */
    description?: string | null;
  }>(),
  { breadcrumbs: null, mono: false, count: null, description: null },
);
const slots = useSlots();

/** A list page centres its button on the title; a detail page tops it. */
const align = computed(() =>
  props.breadcrumbs || props.description || slots.meta ? 'items-start' : 'items-center',
);
</script>

<template>
  <div class="flex flex-wrap justify-between gap-12" :class="align">
    <div class="flex min-w-0 flex-col gap-4">
      <BaseBreadcrumb v-if="breadcrumbs && breadcrumbs.length" :items="breadcrumbs" />
      <div
        class="flex flex-wrap gap-10"
        :class="$slots['title-extra'] ? 'items-center' : 'items-baseline'"
      >
        <h1 class="text-20 font-semibold" :class="{ 'font-mono': mono }">{{ title }}</h1>
        <span v-if="count !== null && count !== undefined" class="text-text-3">{{ count }}</span>
        <slot name="title-extra" />
      </div>
      <slot name="meta">
        <p v-if="description" class="text-text-2">{{ description }}</p>
      </slot>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-8">
      <slot name="actions" />
    </div>
  </div>
</template>

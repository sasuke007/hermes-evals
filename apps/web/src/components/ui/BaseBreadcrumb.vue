<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { BreadcrumbItem } from './types';

/**
 * Where a detail page sits: "Experiments / Skill vs no skill, invoices-v1". Every item but
 * the last is a link; the last is the current page (aria-current). Caption size, --text-3.
 */
defineProps<{ items: BreadcrumbItem[] }>();
</script>

<template>
  <nav aria-label="Breadcrumb" class="text-12 text-text-3">
    <ol class="inline">
      <li v-for="(item, i) in items" :key="i" class="inline">
        <RouterLink v-if="item.to && i < items.length - 1" :to="item.to">{{
          item.label
        }}</RouterLink>
        <span v-else :aria-current="i === items.length - 1 ? 'page' : undefined">{{
          item.label
        }}</span>
        <span v-if="i < items.length - 1" aria-hidden="true"> / </span>
      </li>
    </ol>
  </nav>
</template>

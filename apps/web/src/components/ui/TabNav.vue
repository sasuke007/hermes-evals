<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { TabItem } from './types';

/** Route-backed tabs (experiment Overview · Comparison · Runs, resource tabs). */
defineProps<{ tabs: TabItem[]; label: string }>();
</script>

<template>
  <nav class="flex items-center gap-4 border-b border-border" :aria-label="label">
    <RouterLink
      v-for="tab in tabs"
      :key="tab.key ?? tab.label"
      v-slot="{ href, navigate, isActive, isExactActive }"
      :to="tab.to"
      custom
    >
      <a
        class="-mb-1 inline-flex h-38 items-center gap-6 border-b-2 border-transparent px-12 font-medium text-text-2 no-underline hover:text-text hover:no-underline aria-[current=page]:border-accent aria-[current=page]:text-text"
        :href="href"
        :aria-current="(tab.active ?? (tab.exact ? isExactActive : isActive)) ? 'page' : undefined"
        @click="navigate"
      >
        {{ tab.label }}
        <span
          v-if="tab.count !== null && tab.count !== undefined"
          class="font-mono text-12 text-text-3"
          >{{ tab.count }}</span
        >
        <slot name="extra" :tab="tab" />
      </a>
    </RouterLink>
    <slot />
  </nav>
</template>

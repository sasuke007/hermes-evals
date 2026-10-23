<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { TabItem } from './types';

/** Route-backed tabs (experiment Overview · Comparison · Runs, resource tabs). */
defineProps<{ tabs: TabItem[]; label: string }>();
</script>

<template>
  <nav class="tabs" :aria-label="label">
    <RouterLink
      v-for="tab in tabs"
      :key="tab.key ?? tab.label"
      v-slot="{ href, navigate, isActive, isExactActive }"
      :to="tab.to"
      custom
    >
      <a
        class="tab"
        :href="href"
        :aria-current="(tab.exact ? isExactActive : isActive) ? 'page' : undefined"
        @click="navigate"
      >
        {{ tab.label }}
        <span
          v-if="tab.count !== null && tab.count !== undefined"
          class="t3 mono"
          style="font-size: 12px"
          >{{ tab.count }}</span
        >
        <slot name="extra" :tab="tab" />
      </a>
    </RouterLink>
    <slot />
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import BaseBreadcrumb from '@/components/ui/BaseBreadcrumb.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { ROUTE_NAMES } from '@/router';
import { suiteDraftRoute } from './editorRoutes';

/**
 * The task editor before its task is on screen (SA.13): the skeleton keeps the tabs, the
 * sections and the 360px panel where they will be; a load error keeps the page's head and
 * says the draft is kept, with the request verbatim and Retry.
 */
const props = defineProps<{
  folder: string;
  taskKey: string;
  error: string | null;
  savedAt: string | null;
}>();
defineEmits<{ retry: [] }>();

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
  { label: props.folder, to: suiteDraftRoute(props.folder) },
  { label: props.taskKey },
  { label: 'Edit' },
]);
const hint = computed(() =>
  props.savedAt
    ? `The draft was saved at ${props.savedAt} and is kept. Retry loads it again.`
    : 'The draft is kept. Retry loads it again.',
);
const BAR = 'block h-10 animate-shimmer rounded-3 bg-surface-3';
</script>

<template>
  <div class="flex flex-col gap-6">
    <BaseBreadcrumb :items="breadcrumbs" />
    <h1 class="m-0 font-mono text-20 font-semibold">{{ taskKey }}</h1>
  </div>
  <ErrorBanner
    v-if="error"
    :title="`Could not load ${taskKey}`"
    :detail="error"
    :hint="hint"
    retry-label="Retry"
    @retry="$emit('retry')"
  />
  <div v-else class="flex flex-col gap-10" aria-busy="true" data-testid="task-loading">
    <div class="flex gap-16">
      <span :class="BAR" class="w-40" /><span :class="BAR" class="w-40" /><span
        :class="BAR"
        class="w-60"
      />
    </div>
    <span :class="BAR" class="w-320" />
    <div class="grid grid-cols-[minmax(0,1fr)_360px] gap-24 max-lg:grid-cols-1">
      <div class="flex flex-col gap-10">
        <div
          v-for="n in 3"
          :key="n"
          class="flex flex-col gap-8 rounded-6 border border-border bg-surface px-12 py-10"
        >
          <span :class="BAR" class="w-120" /><span :class="BAR" class="w-full" /><span
            :class="BAR"
            class="w-2/3"
          />
        </div>
      </div>
      <div class="flex flex-col gap-9 rounded-6 border border-border bg-surface p-10">
        <span v-for="n in 6" :key="n" :class="BAR" :style="{ width: `${60 + ((n * 37) % 35)}%` }" />
      </div>
    </div>
  </div>
</template>

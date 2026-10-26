<script setup lang="ts">
import { computed } from 'vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { ROUTE_NAMES } from '@/router';

/**
 * A suite draft before it is on screen (SA.13): the skeleton, which keeps the bar and the
 * task table where they will be; the load error, with the request verbatim, Retry, and the
 * reassurance that the draft is kept; and a folder with no draft, which offers to start one
 * (that state has no board: its copy is the engineers').
 */
const props = defineProps<{
  folder: string;
  error: string | null;
  missing: boolean;
  busy: boolean;
  actionError: string | null;
}>();
defineEmits<{ retry: []; start: [] }>();

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
  { label: props.folder },
]);
</script>

<template>
  <PageHeader :title="`${folder} · draft`" :breadcrumbs="breadcrumbs" mono />
  <ErrorBanner
    v-if="error"
    :title="`Could not load the draft of ${folder}`"
    :detail="error"
    hint="The draft is stored by the api service, not in this tab, so nothing is lost. Retry loads it again."
    retry-label="Retry"
    @retry="$emit('retry')"
  />
  <div
    v-else-if="missing"
    class="flex flex-col items-center gap-10 rounded-6 border border-border bg-surface px-24 py-40 text-center"
    data-testid="draft-missing"
  >
    <b class="text-15">No draft of {{ folder }}</b>
    <p class="m-0 max-w-520 text-text-2">
      Start a draft to edit this suite. It begins on the current version; nothing on disk changes
      until you save.
    </p>
    <button type="button" class="btn primary" :disabled="busy" @click="$emit('start')">
      Start a draft
    </button>
    <span v-if="actionError" role="alert" class="text-12 text-fail-text">{{ actionError }}</span>
  </div>
  <div v-else class="flex flex-col gap-10" aria-busy="true" data-testid="draft-loading">
    <div class="flex items-center gap-12 rounded-6 border border-border bg-surface px-12 py-10">
      <span class="h-10 w-60 animate-shimmer rounded-3 bg-surface-3" />
      <span class="h-10 w-200 animate-shimmer rounded-3 bg-surface-3" />
      <span class="flex-1" />
      <span class="h-16 w-160 animate-shimmer rounded-3 bg-surface-3" />
    </div>
    <div class="overflow-hidden rounded-6 border border-border bg-surface">
      <div
        v-for="n in 5"
        :key="n"
        class="grid grid-cols-[16px_120px_70px_1fr_60px] items-center gap-12 border-b border-border px-10 py-8 last:border-b-0"
      >
        <span class="h-10 animate-shimmer rounded-3 bg-surface-3" /><span
          class="h-10 animate-shimmer rounded-3 bg-surface-3"
        /><span class="h-10 animate-shimmer rounded-3 bg-surface-3" /><span
          class="h-10 animate-shimmer rounded-3 bg-surface-3"
        /><span class="h-10 animate-shimmer rounded-3 bg-surface-3" />
      </div>
    </div>
  </div>
</template>

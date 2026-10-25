<script setup lang="ts">
import { computed } from 'vue';
import type { SuiteLastLoad, SuiteLoadErrorView } from '@/api/types/suites';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { formatDateTime, shortHash } from '@/lib/format';

/**
 * A suite directory that could not be reloaded (LibraryStates › "Suites · reload failed"):
 * where the file stopped parsing and why, that nothing changed and which version is still
 * served, with Retry, then the lines around the error with the failing one marked.
 */
const props = withDefaults(
  defineProps<{
    name: string;
    error: SuiteLoadErrorView;
    servedVersion: SuiteLastLoad['servedVersion'];
    busy?: boolean;
  }>(),
  { busy: false },
);
defineEmits<{ retry: [] }>();

/** ./suites/invoices-v1/vat_split/task.yaml:14:9 · mapping values are not allowed here */
const where = computed(() => {
  const e = props.error;
  const at = e.line === null ? '' : e.column === null ? `:${e.line}` : `:${e.line}:${e.column}`;
  return `${e.file}${at} · ${e.message}`;
});
/** The excerpt's line-number gutter is as wide as its widest number. */
const gutter = computed(() =>
  Math.max(...props.error.excerpt.map((l) => String(l.line ?? '').length), 1),
);
const numberOf = (line: number | null): string => String(line ?? '').padStart(gutter.value, ' ');
</script>

<template>
  <div
    class="flex flex-col gap-12 rounded-6 border border-border bg-surface p-16"
    data-testid="reload-failed"
  >
    <ErrorBanner
      :title="`${name} could not be reloaded`"
      :retry-label="busy ? null : 'Retry'"
      @retry="$emit('retry')"
    >
      <code class="wrap-anywhere text-text-2">{{ where }}</code>
      <template v-if="servedVersion" #hint
        >Nothing changed. The suite still serves v{{ servedVersion.versionNumber }}, loaded
        {{ formatDateTime(servedVersion.loadedAt) }} (<code>{{
          shortHash(servedVersion.contentHash)
        }}</code
        >). No new version was created.</template
      >
    </ErrorBanner>
    <pre
      v-if="error.excerpt.length"
      class="overflow-x-auto rounded-4 border border-border bg-surface px-12 py-10 font-mono text-12 leading-18"
      data-testid="reload-excerpt"
    ><template v-for="(l, i) in error.excerpt" :key="i"><span :class="{ 'font-semibold text-fail-text': l.highlight }">{{ numberOf(l.line) }} | {{ l.text }}</span>
</template></pre>
  </div>
</template>

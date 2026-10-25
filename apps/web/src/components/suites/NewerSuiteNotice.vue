<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { ExperimentSuiteSnapshot } from '@/api/types/experiments';
import { ROUTE_NAMES } from '@/router';
import { plural } from '@/lib/format';

/**
 * The notice on an older experiment whose suite has a newer version (plan 4.5, the
 * OverviewComplete board's snapshot strip): "A newer version of invoices-v1 exists (v5):
 * 1 task changed (total_due)." with Duplicate on v5, which opens New experiment prefilled
 * from this experiment on the suite's current version. Renders nothing when the experiment
 * ran on the current version.
 */
const props = defineProps<{
  suite: Pick<ExperimentSuiteSnapshot, 'name' | 'newerVersion'>;
  experimentId: string;
}>();

interface Part {
  lead: string;
  keys: string;
}

const parts = computed<Part[]>(() => {
  const n = props.suite.newerVersion;
  if (!n) return [];
  const list: Part[] = [];
  if (n.changedTasks.length)
    list.push({
      lead: `${plural(n.changedTasks.length, 'task')} changed`,
      keys: n.changedTasks.join(', '),
    });
  if (n.removedTasks.length)
    list.push({
      lead: `${plural(n.removedTasks.length, 'task')} removed`,
      keys: n.removedTasks.join(', '),
    });
  if (n.invalidTasks.length)
    list.push({
      lead: `${plural(n.invalidTasks.length, 'task')} now invalid`,
      keys: n.invalidTasks.join(', '),
    });
  return list;
});

const duplicateTo = computed(() => ({
  name: ROUTE_NAMES.experimentNew,
  query: { from: props.experimentId },
}));
</script>

<template>
  <span
    v-if="suite.newerVersion"
    role="status"
    class="flex flex-wrap items-center gap-x-12 gap-y-8 rounded-4 border border-border-strong bg-accent-soft px-10 py-8"
    data-testid="newer-suite-version"
  >
    <span class="min-w-240 flex-1 text-12 leading-18"
      >A newer version of <code>{{ suite.name }}</code> exists (<b
        >v{{ suite.newerVersion.versionNumber }}</b
      >)<template v-if="parts.length"
        >:
        <template v-for="(p, i) in parts" :key="p.lead"
          >{{ i > 0 ? ', ' : '' }}{{ p.lead }} (<code>{{ p.keys }}</code
          >)</template
        ></template
      >.</span
    >
    <RouterLink class="btn sm" :to="duplicateTo"
      >Duplicate on v{{ suite.newerVersion.versionNumber }}</RouterLink
    >
  </span>
</template>

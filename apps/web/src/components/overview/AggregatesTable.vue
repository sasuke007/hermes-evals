<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { ConfigAggregate } from '@/api/types/experiments';
import { MISSING, formatCount, formatRate, formatUsd } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { formatSeconds } from './overview';

/**
 * Per-configuration aggregates (OverviewComplete): pass rate, mean score, median duration,
 * mean tokens, estimated cost, and the execution errors and ungradable runs that count as not
 * passed. A non-zero error count links to the Runs tab with that filter applied.
 */
const props = defineProps<{ aggregates: ConfigAggregate[]; experimentId: string }>();

const caption = computed(() => {
  const runs = new Set(props.aggregates.map((a) => a.runs));
  const each = runs.size === 1 ? `${[...runs][0]} runs each` : null;
  return [each, 'cost estimated from token counts and the price table'].filter(Boolean).join(' · ');
});
const best = computed(() =>
  Math.max(...props.aggregates.map((a) => a.passRate ?? Number.NEGATIVE_INFINITY)),
);
const isBest = (a: ConfigAggregate): boolean =>
  props.aggregates.length > 1 && a.passRate !== null && a.passRate === best.value;

function runsLink(a: ConfigAggregate, filter: 'exec_error' | 'ungradable'): RouteLocationRaw {
  return {
    name: ROUTE_NAMES.experimentRuns,
    params: { id: props.experimentId },
    query: { config: a.configuration.name, [filter]: '1' },
  };
}
</script>

<template>
  <section
    class="flex flex-col gap-8"
    aria-labelledby="aggregates-heading"
    data-testid="aggregates"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-8">
      <h2 id="aggregates-heading" class="text-15 font-semibold">Per-configuration aggregates</h2>
      <span class="text-12 text-text-3">{{ caption }}</span>
    </div>
    <div class="tbl">
      <table class="dt h36 static" aria-labelledby="aggregates-heading">
        <thead>
          <tr>
            <th scope="col">Configuration</th>
            <th scope="col" class="text-right">Pass rate</th>
            <th scope="col" class="text-right">Mean score</th>
            <th scope="col" class="text-right">Median duration</th>
            <th scope="col" class="text-right">Mean tokens</th>
            <th scope="col" class="text-right">Est. cost</th>
            <th scope="col" class="text-right">Execution errors</th>
            <th scope="col" class="text-right">Ungradable runs</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in aggregates"
            :key="a.configuration.versionId"
            :data-config="a.configuration.name"
          >
            <td>
              <span class="inline-flex items-baseline gap-4">
                <span class="font-mono font-semibold">{{ a.configuration.name }}</span>
                <span class="text-text-3">{{ a.configuration.role }}</span>
              </span>
            </td>
            <td class="text-right" :class="{ 'font-semibold': isBest(a) }">
              {{ formatRate(a.passRate) }}
            </td>
            <td class="text-right">{{ formatRate(a.meanScore) }}</td>
            <td class="text-right">{{ formatSeconds(a.medianDurationS) }}</td>
            <td class="text-right">{{ formatCount(a.meanTokens) }}</td>
            <td
              class="text-right"
              :class="{ 'text-text-3': a.costUsd === null }"
              :title="a.costUsd === null ? 'No attempt of this configuration is priced' : undefined"
            >
              {{ a.costUsd === null ? MISSING : formatUsd(a.costUsd) }}
            </td>
            <td class="text-right">
              <RouterLink
                v-if="a.executionErrors > 0"
                :to="runsLink(a, 'exec_error')"
                class="font-semibold text-err-text hover:text-err-text"
                :title="a.executionErrorCategories.join(', ')"
                >{{ a.executionErrors }}</RouterLink
              >
              <span v-else class="text-text-3">0</span>
            </td>
            <td class="text-right">
              <RouterLink
                v-if="a.ungradable > 0"
                :to="runsLink(a, 'ungradable')"
                class="font-semibold text-ung-text hover:text-ung-text"
                >{{ a.ungradable }}</RouterLink
              >
              <span v-else class="text-text-3">0</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="text-12 text-text-3">
      A non-zero error count is a link to the Runs tab with that filter applied. Execution errors
      and ungradable runs count as not passed in the pass rate, and they are listed here so a
      difference caused by them is visible.
    </p>
  </section>
</template>

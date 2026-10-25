<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import { formatCount, formatDuration, formatUsd, MISSING } from '@/lib/format';
import { sensitivitySentence } from './readings';
import type { ComparisonView, SecondaryMetricsRow } from '@/api/types/experiments';
import { ROUTE_NAMES } from '@/router';

/**
 * Secondary metrics (Comparison board): per configuration, over its counted runs, the median
 * duration, mean tokens, estimated cost (every attempt of the arm, as the Overview prices it),
 * execution errors with their categories and ungradable runs, then the candidate's difference
 * from the baseline. A non-zero error or ungradable count links to the Runs tab filtered to
 * those runs. The sensitivity line under it says what the verdict is without the runs that
 * broke rather than answered.
 */
const props = defineProps<{ view: ComparisonView }>();

const difference = computed(() => props.view.secondaryDifference);
const sensitivity = computed(() => sensitivitySentence(props.view));

function runsLink(row: SecondaryMetricsRow, flag: 'exec_error' | 'ungradable'): RouteLocationRaw {
  return {
    name: ROUTE_NAMES.experimentRuns,
    params: { id: props.view.experimentId },
    query: { config: row.configuration.name, [flag]: '1' },
  };
}

/** A signed whole number with a true minus: +3, −1, 0. */
function signed(n: number, unit = ''): string {
  if (n === 0) return `0${unit}`;
  return `${n > 0 ? '+' : '−'}${Math.abs(n)}${unit}`;
}
/** A signed duration: +13 s, −1m 04s. */
function signedDuration(s: number | null): string {
  if (s === null) return MISSING;
  const text = formatDuration(Math.abs(s));
  return Math.round(s) === 0 ? text : `${s > 0 ? '+' : '−'}${text}`;
}
/** A signed amount of money: +$0.27, −$0.05. */
function signedUsd(v: number | null): string {
  if (v === null) return MISSING;
  const text = formatUsd(Math.abs(v));
  return v === 0 ? text : `${v > 0 ? '+' : '−'}${text}`;
}
</script>

<template>
  <section
    class="flex flex-col rounded-6 border border-border bg-surface"
    aria-labelledby="cmp-secondary"
    data-testid="secondary-metrics"
  >
    <div class="flex flex-col gap-2 border-b px-16 py-14">
      <h2 id="cmp-secondary" class="text-15 font-semibold">Secondary metrics</h2>
      <span class="text-12 text-text-3"
        >Is the win really about answers, or about time and failures?</span
      >
    </div>
    <div class="overflow-x-auto">
      <table class="dt h36">
        <thead>
          <tr>
            <th>Configuration</th>
            <th class="text-right">Median duration</th>
            <th class="text-right">Mean tokens</th>
            <th class="text-right">Est. cost</th>
            <th class="text-right">Exec. errors</th>
            <th class="text-right">Ungradable</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in view.secondary" :key="row.configuration.versionId">
            <td class="font-mono font-semibold">{{ row.configuration.name }}</td>
            <td class="text-right">{{ formatDuration(row.medianDurationS) }}</td>
            <td class="text-right">{{ formatCount(row.meanTokens) }}</td>
            <td class="text-right">{{ formatUsd(row.costUsd) }}</td>
            <td class="text-right" :class="{ 'text-text-3': row.executionErrors === 0 }">
              <template v-if="row.executionErrors > 0">
                <RouterLink
                  :to="runsLink(row, 'exec_error')"
                  class="font-semibold text-err-text"
                  :aria-label="`${row.executionErrors} execution errors of ${row.configuration.name}: open them in Runs`"
                  >{{ row.executionErrors }}</RouterLink
                >
                <span v-if="row.executionErrorCategories.length" class="text-12 text-text-3">{{
                  ` ${row.executionErrorCategories.join(', ')}`
                }}</span>
              </template>
              <template v-else>0</template>
            </td>
            <td class="text-right" :class="{ 'text-text-3': row.ungradable === 0 }">
              <RouterLink
                v-if="row.ungradable > 0"
                :to="runsLink(row, 'ungradable')"
                class="font-semibold text-ung-text"
                :aria-label="`${row.ungradable} ungradable runs of ${row.configuration.name}: open them in Runs`"
                >{{ row.ungradable }}</RouterLink
              >
              <template v-else>0</template>
            </td>
          </tr>
          <tr v-if="difference" data-testid="secondary-difference">
            <td class="text-text-2">Difference</td>
            <td class="text-right text-text-2">{{ signedDuration(difference.medianDurationS) }}</td>
            <td class="text-right text-text-2">
              {{
                difference.meanTokensPct === null ? MISSING : signed(difference.meanTokensPct, '%')
              }}
            </td>
            <td class="text-right text-text-2">{{ signedUsd(difference.costUsd) }}</td>
            <td class="text-right text-text-2">{{ signed(difference.executionErrors) }}</td>
            <td class="text-right text-text-2">{{ signed(difference.ungradable) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="sensitivity" class="flex items-start gap-10 border-t px-16 py-12">
      <svg
        class="mt-2 flex-none text-accent"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M8 7.2v4M8 4.8h.01"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
      <p class="text-12 leading-18 text-text-2" data-testid="sensitivity">{{ sensitivity }}</p>
    </div>
  </section>
</template>

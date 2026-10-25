<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { ExperimentDetail } from '@/api/types/experiments';
import BaseTag from '@/components/ui/BaseTag.vue';
import KeyValueList from '@/components/ui/KeyValueList.vue';
import type { KeyValueItem } from '@/components/ui/types';
import NewerSuiteNotice from '@/components/suites/NewerSuiteNotice.vue';
import { formatUsd, shortHash } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { hermesLabel, suiteTasksLabel } from './overview';

/**
 * What was tested (OverviewComplete): the snapshot frozen at launch as a label column and a
 * value column, with the notice that the suite has a newer version and "Duplicate on vN"
 * (section 4.5), and what the candidate differs in.
 */
const props = defineProps<{ detail: ExperimentDetail }>();

const repetitionsLine = computed(() => {
  const d = props.detail;
  const ceiling =
    d.spend.ceilingUsd === null
      ? 'no spend ceiling'
      : `spend ceiling ${formatUsd(d.spend.ceilingUsd)}`;
  const budget =
    d.timeBudgetOverrideS === null ? [] : [`time budget ${d.timeBudgetOverrideS} s per run`];
  return [String(d.repetitions), `concurrency ${d.concurrency}`, ceiling, ...budget].join(' · ');
});

const items = computed<KeyValueItem[]>(() => [
  { key: 'suite', label: 'Suite' },
  { key: 'baseline', label: 'Baseline' },
  {
    key: 'candidates',
    label: props.detail.candidates.length > 1 ? 'Candidates' : 'Candidate',
  },
  { key: 'differs', label: 'Differs in' },
  { key: 'hermes', label: 'Hermes revision', value: hermesLabel(props.detail), mono: true },
  {
    key: 'scoreKey',
    label: 'Score key',
    value: props.detail.scoreKey === 'primary' ? 'Primary key of each task' : props.detail.scoreKey,
  },
  { key: 'repetitions', label: 'Repetitions', value: repetitionsLine.value },
]);

const multiple = computed(() => props.detail.candidates.length > 1);
const configLink = (c: { configurationId: string; version: number }) => ({
  name: ROUTE_NAMES.configuration,
  params: { id: c.configurationId },
  query: { version: String(c.version) },
});
</script>

<template>
  <section
    class="flex flex-col gap-12 rounded-6 border border-border bg-surface p-20"
    aria-labelledby="what-was-tested"
    data-testid="what-was-tested"
  >
    <h2 id="what-was-tested" class="text-15 font-semibold">What was tested</h2>
    <p class="text-12 text-text-3">
      Frozen when the experiment was created. Later edits to suites or configurations do not change
      this experiment.
    </p>
    <KeyValueList :items="items">
      <template #value-suite>
        <div class="flex flex-col gap-8">
          <span class="inline-flex flex-wrap items-baseline gap-x-4">
            <span class="font-mono">{{ detail.suite.name }}</span>
            <b>v{{ detail.suite.versionNumber }}</b>
            <span class="text-text-3">· {{ suiteTasksLabel(detail) }}</span>
            <BaseTag>{{ shortHash(detail.suite.contentHash) }}</BaseTag>
            <RouterLink :to="{ name: ROUTE_NAMES.suite, params: { id: detail.suite.suiteId } }"
              >view v{{ detail.suite.versionNumber }}</RouterLink
            >
          </span>
          <NewerSuiteNotice :suite="detail.suite" :experiment-id="detail.id" />
        </div>
      </template>
      <template #value-baseline>
        <span class="inline-flex flex-wrap items-baseline gap-x-4">
          <span class="font-mono">{{ detail.baseline.name }}</span>
          <BaseTag>v{{ detail.baseline.version }}</BaseTag>
          <span>·</span>
          <RouterLink :to="configLink(detail.baseline)">view as of this experiment</RouterLink>
        </span>
      </template>
      <template #value-candidates>
        <div class="flex flex-col gap-4">
          <span
            v-for="c in detail.candidates"
            :key="c.versionId"
            class="inline-flex flex-wrap items-baseline gap-x-4"
          >
            <span class="font-mono">{{ c.name }}</span>
            <BaseTag>v{{ c.version }}</BaseTag>
            <span>·</span>
            <RouterLink :to="configLink(c)">view as of this experiment</RouterLink>
          </span>
        </div>
      </template>
      <template #value-differs>
        <div v-if="detail.differences.length" class="flex flex-col gap-4">
          <span
            v-for="(d, i) in detail.differences"
            :key="i"
            class="inline-flex flex-wrap items-baseline gap-x-4"
          >
            <template v-if="multiple">
              <span class="font-mono">{{ d.candidate }}</span>
              <span>·</span>
            </template>
            <span class="font-mono">{{ d.field }}:</span>
            <span class="font-mono">{{ d.candidateValue }}</span>
            <BaseTag v-if="d.hash">sha256:{{ d.hash.slice(0, 8) }}</BaseTag>
          </span>
        </div>
        <span v-else class="text-text-3">Nothing: the configurations are the same.</span>
      </template>
    </KeyValueList>
  </section>
</template>

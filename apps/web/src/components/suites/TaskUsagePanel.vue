<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { TaskExperimentUsage } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import { formatRate, MISSING } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';

/**
 * The experiments that ran this task version (TaskDetail board, "In experiments"): the
 * task's pass rate per configuration, with "scored / total" while an experiment is still
 * running. Experiments on other versions of the task are listed on those versions.
 */
const props = defineProps<{
  experiments: TaskExperimentUsage[];
  version: number;
  /** The task has had more than one version. */
  versioned: boolean;
}>();

const rows = computed(() =>
  props.experiments.flatMap((e) =>
    e.rows.map((r, i) => ({ experiment: e, row: r, first: i === 0 })),
  ),
);
const note = computed(() => {
  if (props.experiments.length === 0) return `No experiment has run task v${props.version} yet.`;
  return props.versioned
    ? `Only experiments on task v${props.version} are listed. Results on other versions are not comparable.`
    : `Every experiment so far ran on task v${props.version}.`;
});
const experimentTo = (id: string) => ({ name: ROUTE_NAMES.experimentOverview, params: { id } });
</script>

<template>
  <BasePanel title="In experiments" meta="pass rate on this task" clip>
    <table
      v-if="rows.length"
      class="dt th30 inset14 static"
      aria-label="Experiments that ran this task"
    >
      <thead>
        <tr>
          <th scope="col">Experiment</th>
          <th scope="col">Configuration</th>
          <th scope="col" class="text-right">Pass</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(r, i) in rows"
          :key="i"
          :data-experiment="r.experiment.experimentId"
          :data-configuration="r.row.configuration"
        >
          <td class="whitespace-normal">
            <template v-if="r.first">
              <RouterLink :to="experimentTo(r.experiment.experimentId)">{{
                r.experiment.experimentName
              }}</RouterLink>
              <template v-if="r.experiment.status !== 'completed'">
                {{ ' ' }}
                <StatusChip
                  kind="experiment"
                  :status="r.experiment.status"
                  size="sm"
                  :dot="false"
                />
              </template>
            </template>
          </td>
          <td class="font-mono text-12">{{ r.row.configuration }}</td>
          <td
            class="text-right"
            :class="
              r.row.passRate === null
                ? 'text-text-3'
                : r.experiment.status !== 'completed'
                  ? 'text-text-2'
                  : undefined
            "
          >
            {{ r.row.passRate === null ? MISSING : formatRate(r.row.passRate, 2) }}
            <span v-if="r.experiment.status !== 'completed'" class="text-12 text-text-3"
              >{{ r.row.scored }} / {{ r.row.total }}</span
            >
          </td>
        </tr>
      </tbody>
    </table>
    <p class="px-16 py-8 text-12 text-text-3" :class="{ 'border-t border-border': rows.length }">
      {{ note }}
    </p>
  </BasePanel>
</template>

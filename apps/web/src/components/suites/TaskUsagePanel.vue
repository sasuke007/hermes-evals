<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { TaskExperimentUsage } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import { formatRate, MISSING } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { comparabilityNote } from './usageNotes';

/**
 * "In experiments" on Task detail (TaskDetail board): every experiment that ran any version
 * of the task. A task with one version draws the task's pass rate per configuration, with
 * "scored / total" while an experiment is still running. A task with several versions draws
 * which task version and suite version each experiment ran instead, and says why results on
 * different versions do not compare (Phase 5 section 6.1).
 */
const props = withDefaults(
  defineProps<{
    experiments: TaskExperimentUsage[];
    /** The task version on screen. */
    version: number;
    /** The task has had more than one version. */
    versioned: boolean;
    /** The version on screen failed its self-check. */
    valid?: boolean;
    /** What changed in the newest version the experiments ran, from the task's History. */
    changedFiles?: string[];
  }>(),
  { valid: true, changedFiles: () => [] },
);

const rows = computed(() =>
  props.experiments.flatMap((e) =>
    e.rows.map((r, i) => ({ experiment: e, row: r, first: i === 0 })),
  ),
);
const note = computed(() => {
  if (props.versioned) {
    return comparabilityNote({
      experiments: props.experiments,
      version: props.version,
      valid: props.valid,
      changedFiles: props.changedFiles,
    });
  }
  if (props.experiments.length === 0) return `No experiment has run task v${props.version} yet.`;
  return `Every experiment so far ran on task v${props.version}.`;
});
const experimentTo = (id: string) => ({ name: ROUTE_NAMES.experimentOverview, params: { id } });
</script>

<template>
  <BasePanel
    title="In experiments"
    :meta="versioned ? 'which task version each one ran' : 'pass rate on this task'"
    clip
  >
    <table
      v-if="versioned && experiments.length"
      class="dt th30 inset14 static"
      aria-label="Experiments that ran this task"
      data-testid="usage-versioned"
    >
      <thead>
        <tr>
          <th scope="col">Experiment</th>
          <th scope="col">Task version</th>
          <th scope="col" class="text-right">Suite</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="e in experiments"
          :key="e.experimentId"
          :data-experiment="e.experimentId"
          :data-task-version="e.taskVersion"
        >
          <td class="whitespace-normal">
            <RouterLink :to="experimentTo(e.experimentId)">{{ e.experimentName }}</RouterLink>
            <template v-if="e.status !== 'completed'">
              {{ ' ' }}
              <StatusChip kind="experiment" :status="e.status" size="sm" :dot="false" />
            </template>
          </td>
          <td class="font-mono text-12" :class="{ 'font-semibold': e.taskVersion === version }">
            v{{ e.taskVersion }}
          </td>
          <td class="text-right">v{{ e.suiteVersion }}</td>
        </tr>
      </tbody>
    </table>
    <table
      v-else-if="rows.length"
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
    <p
      class="px-16 py-8 text-12 text-text-3"
      :class="{ 'border-t border-border': experiments.length }"
      data-testid="usage-note"
    >
      {{ note }}
    </p>
  </BasePanel>
</template>

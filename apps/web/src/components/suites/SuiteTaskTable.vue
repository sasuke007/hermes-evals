<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { SuiteTaskRow } from '@/api/types/suites';
import BaseTag from '@/components/ui/BaseTag.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import type { SkeletonColumn } from '@/components/ui/types';
import { MISSING } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import SelfCheckFailure from './SelfCheckFailure.vue';

/**
 * The tasks of one suite version (SuiteDetail board): key, task version (bold in the run
 * colour when this version changed it), summary, check types, limits, fixtures and validity.
 * A task that failed its self-check is tinted, and its "self-check failed" chip expands the
 * row to the check's output; invalid rows start expanded. `reveal(key)` expands a row and
 * moves focus to its chip ("Show late_fees").
 */
const props = withDefaults(
  defineProps<{
    suiteId: string;
    tasks: SuiteTaskRow[];
    /** Task keys this version changed, against the version before it. */
    changedKeys?: string[];
    /** Skeleton rows at the column widths while the suite loads. */
    loading?: boolean;
  }>(),
  { changedKeys: () => [], loading: false },
);

const SKELETON: SkeletonColumn[] = [
  { width: 90 },
  { width: 20 },
  { width: ['70%', '55%', '62%'] },
  { width: 150 },
  { width: 20, align: 'right' },
  { width: 36, align: 'right' },
  { width: 12, align: 'right' },
  { width: 44 },
];

const expanded = ref<Set<string>>(new Set());
watch(
  () => props.tasks.filter((t) => !t.valid).map((t) => t.key),
  (keys) => (expanded.value = new Set(keys)),
  { immediate: true },
);

function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

const rowId = (key: string): string => `task-${key}`;
const taskTo = (key: string) => ({
  name: ROUTE_NAMES.task,
  params: { id: props.suiteId, key },
});

async function reveal(key: string): Promise<void> {
  expanded.value = new Set([...expanded.value, key]);
  await nextTick();
  const row = document.getElementById(rowId(key));
  row?.scrollIntoView?.({ block: 'center' });
  row?.querySelector<HTMLElement>('[data-testid="validity-toggle"]')?.focus();
}
defineExpose({ reveal });

const budget = (s: number | null): string => (s === null ? MISSING : `${s} s`);
</script>

<template>
  <div class="tbl overflow-visible">
    <table class="dt h38 static" aria-label="Tasks" :aria-busy="loading || undefined">
      <thead>
        <tr>
          <th scope="col">Task</th>
          <th scope="col">Version</th>
          <th scope="col">Summary</th>
          <th scope="col">Verification</th>
          <th scope="col" class="text-right">Max turns</th>
          <th scope="col" class="text-right">Budget</th>
          <th scope="col" class="text-right">Fixtures</th>
          <th scope="col">Validity</th>
          <!-- Phase 5b adds an Actions column (Edit, Duplicate, Remove from suite). -->
        </tr>
      </thead>
      <tbody v-if="loading">
        <SkeletonRows :columns="SKELETON" :rows="6" />
      </tbody>
      <tbody v-else>
        <tr v-if="tasks.length === 0">
          <td colspan="8" class="h-96 text-center whitespace-normal text-text-3">
            This version has no tasks.
          </td>
        </tr>
        <template v-for="task in tasks" :key="task.key">
          <tr
            :id="rowId(task.key)"
            :class="{ '[&>td]:bg-fail-soft': !task.valid }"
            :data-task="task.key"
            :data-valid="task.valid ? 'true' : 'false'"
          >
            <td>
              <RouterLink
                :to="taskTo(task.key)"
                class="font-mono text-12 font-semibold text-text"
                >{{ task.key }}</RouterLink
              >
            </td>
            <td>
              <span
                class="font-mono text-12"
                :class="
                  changedKeys.includes(task.key) ? 'font-semibold text-run-text' : 'text-text-2'
                "
                :data-changed="changedKeys.includes(task.key) ? 'true' : undefined"
                >v{{ task.version }}</span
              >
            </td>
            <td class="whitespace-normal text-text-2">{{ task.summary }}</td>
            <td>
              <div class="flex flex-wrap gap-4">
                <BaseTag v-for="type in task.verificationTypes" :key="type">{{ type }}</BaseTag>
              </div>
            </td>
            <td class="text-right" :class="{ 'text-text-3': task.maxTurns === null }">
              {{ task.maxTurns ?? MISSING }}
            </td>
            <td class="text-right" :class="{ 'text-text-3': task.budgetS === null }">
              {{ budget(task.budgetS) }}
            </td>
            <td class="text-right">{{ task.fixtureCount }}</td>
            <td>
              <span
                v-if="task.valid"
                class="inline-flex items-center gap-6 text-12 text-pass-text"
                data-testid="validity"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M2 6.5l2.5 2.5L10 3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                valid
              </span>
              <button
                v-else
                type="button"
                class="chip border-0 bg-fail-soft text-fail-text"
                :aria-expanded="expanded.has(task.key) ? 'true' : 'false'"
                :aria-controls="`${rowId(task.key)}-failure`"
                data-testid="validity-toggle"
                @click="toggle(task.key)"
              >
                self-check failed {{ expanded.has(task.key) ? '▴' : '▾' }}
              </button>
            </td>
          </tr>
          <tr
            v-if="!task.valid && expanded.has(task.key)"
            :id="`${rowId(task.key)}-failure`"
            class="[&>td]:bg-fail-soft"
          >
            <td colspan="8" class="h-auto px-16 pt-12 pb-16 whitespace-normal">
              <SelfCheckFailure
                v-if="task.selfCheckFailure"
                :failure="task.selfCheckFailure"
                :task-to="taskTo(task.key)"
              />
              <p v-else class="text-text-2">
                This task is invalid.
                <RouterLink :to="taskTo(task.key)">Open task detail</RouterLink> for its self-check.
              </p>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import StatusChip from '@/components/ui/StatusChip.vue';
import type { AttemptView } from '@/api/types/runs';
import { MISSING, formatDateTimeSeconds } from '@/lib/format';
import { endedBy } from './inspectorFormat';

/**
 * Every attempt of a run (RunInspectorStates › Execution error, Scored after a retry): number
 * of the total, status, category, start, duration and what ended it. The attempt the drawer
 * shows is tinted and marked "shown"; a provider lapse retried after resume is marked as not
 * counted against the run.
 */
defineProps<{ attempts: AttemptView[]; shown: number }>();
</script>

<template>
  <div class="overflow-x-auto rounded-6 border border-border bg-surface">
    <table class="dt th30 static" aria-label="Attempts">
      <thead>
        <tr>
          <th>Attempt</th>
          <th>Status</th>
          <th>Category</th>
          <th>Started</th>
          <th class="text-right">Duration</th>
          <th>Ended by</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="attempt in attempts"
          :key="attempt.number"
          :class="{ '[&>td]:bg-surface-2': attempt.number === shown }"
          :data-shown="attempt.number === shown ? 'true' : undefined"
          data-testid="attempt-row"
        >
          <td class="font-mono">
            {{ attempt.number }} of {{ attempts.length }}
            <span v-if="attempt.number === shown" class="font-sans text-12 text-text-3">shown</span>
            <span v-if="!attempt.countsAgainstRun" class="font-sans text-12 text-text-3"
              >not counted</span
            >
          </td>
          <td><StatusChip kind="run" :status="attempt.status" :dot="false" /></td>
          <td class="font-mono" :class="{ 'text-text-3': !attempt.category }">
            {{ attempt.category ?? MISSING }}
          </td>
          <td class="font-mono text-text-2">{{ formatDateTimeSeconds(attempt.startedAt) }}</td>
          <td class="text-right" :class="{ 'text-text-3': attempt.durationS === null }">
            {{ attempt.durationS === null ? MISSING : `${Math.round(attempt.durationS)} s` }}
          </td>
          <td class="text-text-2">{{ endedBy(attempt) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

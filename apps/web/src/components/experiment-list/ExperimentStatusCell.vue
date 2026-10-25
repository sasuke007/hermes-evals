<script setup lang="ts">
import { computed } from 'vue';
import type { ExperimentListRow } from '@/api/types/experiments';
import BaseTooltip from '@/components/ui/BaseTooltip.vue';
import StatusChip from '@/components/ui/StatusChip.vue';

/**
 * The Status column: the experiment's status chip, and for a pause because a provider
 * disconnected the amber "provider disconnected" chip beside it (Components 3, "StatusChip:
 * provider and pause reason"; the experiment header draws the same pair). Its reason, as the
 * API words it, is the chips' tooltip, on hover and on keyboard focus: "invoice-db failed to
 * start (setup) in 14 of 14 runs" for a failed experiment, "Paused by the user" for a user
 * pause.
 */
const props = defineProps<{ row: ExperimentListRow }>();

/** The reason chip's value, for a pause because a provider disconnected only. */
const reason = computed(() =>
  props.row.status === 'paused' && props.row.pauseReason === 'provider_disconnected'
    ? props.row.pauseReason
    : null,
);
</script>

<template>
  <BaseTooltip v-if="row.statusReason" :text="row.statusReason" v-slot="{ describedBy }">
    <span
      tabindex="0"
      class="inline-flex items-center gap-6 rounded-3"
      :aria-describedby="describedBy"
      data-testid="status-reason-trigger"
    >
      <StatusChip kind="experiment" :status="row.status" />
      <StatusChip v-if="reason" kind="pauseReason" :status="reason" />
    </span>
  </BaseTooltip>
  <span v-else class="inline-flex items-center gap-6">
    <StatusChip kind="experiment" :status="row.status" />
    <StatusChip v-if="reason" kind="pauseReason" :status="reason" />
  </span>
</template>

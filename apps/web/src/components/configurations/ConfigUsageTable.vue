<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import BasePanel from '@/components/ui/BasePanel.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { ConfigurationUsage } from '@/api/types/configurations';
import { MISSING } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { usageRate, usageVerdict } from './configDisplay';

/**
 * Every experiment that used this configuration, with its pass rate there (ConfigDetail ›
 * Used in experiments): final to three decimals once completed, two with the scored count
 * while running or paused; the candidate's verdict against the baseline, "Provisional" while
 * running, or why there is no interval ("No interval (2 tasks)"), with its Δ whenever there is
 * one (usageVerdict). A completed experiment's chip has no dot, as the board
 * draws it, and the Pass rate and Verdict cells wrap their captions when the panel is narrow
 * (half the page from 1440px down).
 */
const props = defineProps<{ usedIn: ConfigurationUsage[] }>();

const rows = computed(() =>
  props.usedIn.map((u) => ({ u, rate: usageRate(u), verdict: usageVerdict(u) })),
);

const overview = (u: ConfigurationUsage) => ({
  name: ROUTE_NAMES.experimentOverview,
  params: { id: u.experimentId },
});
</script>

<template>
  <BasePanel title="Used in experiments" meta="pass rate of this configuration" clip>
    <div class="overflow-x-auto">
      <table class="dt h38" aria-label="Used in experiments">
        <thead>
          <tr>
            <th>Experiment</th>
            <th>Role</th>
            <th>Status</th>
            <th class="text-right">Pass rate</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="usedIn.length === 0" class="hover:[&>td]:bg-transparent">
            <td colspan="5" class="text-text-3">No experiment has used this configuration yet.</td>
          </tr>
          <tr
            v-for="{ u, rate, verdict } in rows"
            :key="`${u.experimentId}:${u.role}`"
            :data-experiment="u.experimentId"
          >
            <td>
              <RouterLink :to="overview(u)">{{ u.experimentName }}</RouterLink>
            </td>
            <td class="text-text-2">{{ u.role }}</td>
            <td>
              <StatusChip kind="experiment" :status="u.status" :dot="u.status !== 'completed'" />
            </td>
            <td class="py-6 text-right whitespace-normal" data-testid="pass-rate">
              <span v-if="rate.value === null && !rate.caption" class="text-text-3">{{
                MISSING
              }}</span>
              <span v-else class="inline-flex flex-wrap items-baseline justify-end gap-x-6">
                <span
                  v-if="rate.value !== null"
                  :class="rate.final ? 'font-semibold' : 'text-text-2'"
                  >{{ rate.value }}</span
                >
                <span v-if="rate.caption" class="text-12 text-text-3">{{ rate.caption }}</span>
              </span>
            </td>
            <td class="py-6 whitespace-normal" data-testid="verdict">
              <span class="inline-flex flex-wrap items-center gap-x-6 gap-y-2">
                <StatusChip v-if="verdict.chip" kind="verdict" :status="verdict.chip" />
                <span v-if="verdict.caption" class="text-12 text-text-3">{{
                  verdict.caption
                }}</span>
                <span v-else-if="!verdict.chip" class="text-12 text-text-3">{{ MISSING }}</span>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </BasePanel>
</template>

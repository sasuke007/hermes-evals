<script setup lang="ts">
import type { ConfigProgress } from '@/api/types/experiments';
import BasePanel from '@/components/ui/BasePanel.vue';
import ProgressBar from '@/components/ui/ProgressBar.vue';
import { configDetailLine, configSegments } from './overview';

/**
 * Per configuration (OverviewRunning): one thin bar per configuration, scored · errors · in
 * flight · queued (hatched), with "scored / total" and the line of counts that ends in the
 * provisional pass rate, passed / scored so far.
 */
defineProps<{ perConfiguration: ConfigProgress[] }>();
</script>

<template>
  <BasePanel title="Per configuration" meta="scored / total" data-testid="per-configuration">
    <div class="flex flex-col gap-18 p-16">
      <div
        v-for="p in perConfiguration"
        :key="p.configuration.versionId"
        class="flex flex-col gap-6"
        :data-config="p.configuration.name"
      >
        <div class="flex items-baseline justify-between gap-8">
          <span class="flex items-baseline gap-4">
            <span class="font-mono font-semibold">{{ p.configuration.name }}</span>
            <span class="text-text-3">{{ p.configuration.role }}</span>
          </span>
          <span class="font-mono text-12">{{ p.counts.scored }} / {{ p.total }}</span>
        </div>
        <ProgressBar
          :max="p.total"
          :now="p.counts.scored"
          :segments="configSegments(p)"
          :height="8"
          :label="`${p.configuration.name}: ${p.counts.scored} of ${p.total} runs scored`"
        />
        <div class="text-12 text-text-3" data-testid="config-detail">{{ configDetailLine(p) }}</div>
      </div>
    </div>
  </BasePanel>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import SandboxCheckList from '@/components/model-access/SandboxCheckList.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import { useSystemStore } from '@/stores/system';
import SystemSection from './SystemSection.vue';

/**
 * System › Sandbox: the newest live worker's isolation self-test (GET /system/sandbox, read
 * again every 30 s). When a check fails, SandboxCheckList says execution is disabled and how
 * to re-run the self-test. With no live worker the API has no report (404), and its sentence
 * says how to start one.
 */
const system = useSystemStore();

const loading = computed(() => system.sandbox === null && system.sandboxError === null);
</script>

<template>
  <SystemSection id="sandbox" title="Sandbox" caption="every run executes in its own container">
    <ErrorBanner
      v-if="system.sandboxError"
      :tone="system.sandboxMissing ? 'warning' : 'error'"
      title="Could not load the isolation report"
      :detail="system.sandboxError"
      :mono="true"
      retry-label="Retry"
      @retry="system.loadSandbox()"
    />
    <div
      v-if="loading"
      class="tbl flex flex-col gap-12 px-16 py-14"
      aria-busy="true"
      aria-label="Loading the isolation report"
    >
      <SkeletonRows
        layout="lines"
        :rows="3"
        :columns="[{ width: ['40%', '55%', '30%'], height: 12 }]"
      />
    </div>
    <SandboxCheckList v-else-if="system.sandbox" :status="system.sandbox" />
  </SystemSection>
</template>

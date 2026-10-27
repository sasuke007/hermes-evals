<script setup lang="ts">
import { computed } from 'vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { useExperimentsStore } from '@/stores/experiments';

/**
 * Above the Overview of an experiment this tab just launched: what the launch went ahead
 * despite (the launch answer's `warnings`, Phase 8 G2), such as the mock model judging a real
 * model's llm_judge checks. A warning, never a block: the experiment runs either way. Dismiss
 * hides it; the answer is the only place it is said, so a reload does too.
 */
const props = defineProps<{ experimentId: string }>();

const experiments = useExperimentsStore();
const warnings = computed(() => experiments.launchWarnings[props.experimentId] ?? []);
</script>

<template>
  <ErrorBanner
    v-if="warnings.length"
    tone="warning"
    :title="warnings.length === 1 ? 'Launched with a warning' : 'Launched with warnings'"
    data-testid="launch-warnings"
  >
    <p v-for="warning in warnings" :key="warning" class="text-text-2">{{ warning }}</p>
    <template #actions>
      <button type="button" class="btn sm" @click="experiments.dismissLaunchWarnings(experimentId)">
        Dismiss
      </button>
    </template>
  </ErrorBanner>
</template>

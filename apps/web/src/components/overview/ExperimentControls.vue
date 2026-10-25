<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { RouterLink } from 'vue-router';
import { Pause, Play } from 'lucide-vue-next';
import type { ExperimentDetail } from '@/api/types/experiments';
import { firstBlocked } from '@/components/runs/modelAccess';
import { ROUTE_NAMES } from '@/router';
import { useExperimentDetailStore } from '@/stores/experiment-detail';
import { useProvidersStore, type FollowUpAction } from '@/stores/providers';

/**
 * The experiment's controls in the page header (OverviewRunning, OverviewComplete,
 * ExperimentStates; UI_FLOWS 15):
 *   running    Pause · Cancel experiment (the page asks first, with ConfirmInline)
 *   paused     Resume · Cancel experiment. After a spend-ceiling pause Resume is in the
 *              raise-ceiling form; after a provider pause it is disabled until the provider is
 *              back, with Reconnect (primary) and "Connect Nous Portal first".
 *   failed     Retry failed runs · Duplicate as new
 *   completed  Duplicate as new
 * Reconnecting never resumes by itself: the ConnectDialog offers "Resume experiment".
 */
const props = withDefaults(defineProps<{ detail: ExperimentDetail; confirming?: boolean }>(), {
  confirming: false,
});
const emit = defineEmits<{ cancel: [] }>();

const store = useExperimentDetailStore();
const providers = useProvidersStore();
const reasonId = `controls-${useId()}`;
const cancelButton = ref<HTMLButtonElement | null>(null);

const status = computed(() => props.detail.status);
const acting = computed(() => store.acting);
/** Cancelled while in-flight runs finish: the API keeps it running until they have. */
const cancelling = computed(() => status.value === 'running' && props.detail.cancelledAt !== null);
const providerIds = computed(() => [
  props.detail.baseline.provider,
  ...props.detail.candidates.map((c) => c.provider),
]);
const blocked = computed(() => firstBlocked(providers, providerIds.value));
const providerPause = computed(
  () => status.value === 'paused' && props.detail.pauseReason === 'provider_disconnected',
);
const canCancel = computed(
  () => (status.value === 'running' || status.value === 'paused') && !cancelling.value,
);
const duplicateLink = computed(() => ({
  name: ROUTE_NAMES.experimentNew,
  query: { from: props.detail.id },
}));

function reconnect(): void {
  void providers.connect(
    'paused-experiment',
    (action: FollowUpAction) => {
      if (action === 'resume') void store.resume();
    },
    {
      experimentName: props.detail.name,
      scored: props.detail.counts.scored,
      total: props.detail.totalRuns,
    },
  );
}

/** Focus returns here when the cancel confirmation closes. */
function focusCancel(): void {
  cancelButton.value?.focus();
}
defineExpose({ focusCancel });
</script>

<template>
  <div class="flex flex-col items-end gap-4" data-testid="experiment-controls">
    <div class="flex flex-wrap items-center gap-8">
      <span v-if="cancelling" class="text-12 text-text-3" data-testid="cancelling"
        >Cancelled · in-flight runs finishing</span
      >
      <button
        v-if="status === 'running' && !cancelling"
        type="button"
        class="btn"
        :disabled="!!acting"
        @click="store.pause()"
      >
        <Pause :size="12" aria-hidden="true" />{{ acting === 'pause' ? 'Pausing…' : 'Pause' }}
      </button>

      <template v-if="status === 'paused' && detail.pauseReason !== 'spend_ceiling'">
        <button
          v-if="providerPause && blocked"
          type="button"
          class="btn"
          disabled
          :title="`Connect ${blocked.name} first`"
          :aria-describedby="reasonId"
        >
          <Play :size="12" aria-hidden="true" />Resume
        </button>
        <button
          v-else
          type="button"
          class="btn primary"
          :disabled="!!acting"
          @click="store.resume()"
        >
          <Play :size="12" aria-hidden="true" />{{ acting === 'resume' ? 'Resuming…' : 'Resume' }}
        </button>
        <button
          v-if="providerPause && blocked?.connectable"
          type="button"
          class="btn primary"
          @click="reconnect"
        >
          Reconnect
        </button>
      </template>

      <template v-if="status === 'failed'">
        <button
          type="button"
          class="btn"
          :disabled="!!acting || !!blocked"
          :title="blocked ? `Retry needs ${blocked.name}.` : undefined"
          :aria-describedby="blocked ? reasonId : undefined"
          @click="store.retryFailed()"
        >
          {{ acting === 'retry-failed' ? 'Retrying…' : 'Retry failed runs' }}
        </button>
      </template>

      <button
        v-if="canCancel && !confirming"
        ref="cancelButton"
        type="button"
        class="btn danger"
        :disabled="!!acting"
        @click="emit('cancel')"
      >
        Cancel experiment
      </button>

      <RouterLink
        v-if="status === 'completed' || status === 'failed'"
        class="btn"
        :to="duplicateLink"
        >Duplicate as new</RouterLink
      >
    </div>
    <span
      v-if="blocked && (providerPause || status === 'failed')"
      :id="reasonId"
      class="text-12 text-ung-text"
      data-testid="controls-reason"
      ><template v-if="blocked.connectable">Connect {{ blocked.name }} first</template
      ><template v-else
        >{{ blocked.name }} is not available.
        <RouterLink :to="{ name: ROUTE_NAMES.system }">Open System</RouterLink></template
      ></span
    >
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import BlockedReason from '@/components/model-access/BlockedReason.vue';
import BaseTooltip from '@/components/ui/BaseTooltip.vue';
import ConfirmInline from '@/components/ui/ConfirmInline.vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import { errorMessage } from '@/api/client';
import type { RunDetail } from '@/api/types/runs';
import { ROUTE_NAMES } from '@/router';
import { useInspectorStore } from '@/stores/inspector';
import { useProvidersStore } from '@/stores/providers';

/**
 * The inspector header's actions (RunInspector, RunInspectorStates): by status,
 *   scored           Same task under <other> (the A/B jump) · Re-score · Copy run id
 *   execution_error  Retry execution · Copy run id
 *   queued, running  Cancel run (confirmed in place) · Copy run id
 *   otherwise        Copy run id
 * The A/B jump stays in place when its counterpart cannot be opened, disabled, with the
 * reason as tooltip and aria-description. Re-score and Retry are disabled through
 * BlockedReason while the provider they need is not ready (with Connect, or the System page
 * for an API key), Re-score when a judge key has no judge model (the API's own sentence),
 * Retry after 5 attempts; a blocked control moves to a line of its own with its reason beside
 * it (RunInspectorStates › Run controls blocked). A refusal from the API is reported to the
 * header, which quotes it.
 */
const props = defineProps<{ detail: RunDetail }>();
const emit = defineEmits<{
  jump: [runId: string];
  /** An action went through: the line the header shows. */
  done: [message: string];
  /** An action was refused: the API's message. */
  failed: [message: string];
}>();

const MAX_ATTEMPTS = 5;

const store = useInspectorStore();
const providers = useProvidersStore();

const status = computed(() => props.detail.status);
const needs = computed(() => props.detail.needs);

/** Why a provider cannot serve model calls right now, or null when it can (or is unknown). */
function providerGap(provider: string | null): { name: string; connect: boolean } | null {
  if (!provider || !providers.loaded) return null;
  if (provider === 'nous')
    return providers.nousConnected ? null : { name: 'Nous Portal', connect: true };
  const info = providers.providers.find((p) => p.id === provider);
  return info && info.status === 'missing' ? { name: info.name, connect: false } : null;
}

// ── A/B jump ────────────────────────────────────────────────────────────────
const counterpart = computed(() => props.detail.counterpart);
const jumpReason = computed(() => {
  const c = counterpart.value;
  if (!c) return null;
  if (c.unavailableReason) return c.unavailableReason;
  return c.runId ? null : `No run of this task and repetition under ${c.configuration}`;
});
function jump(): void {
  const c = counterpart.value;
  if (!c?.runId || jumpReason.value) return;
  emit('jump', c.runId);
}

// ── Re-score ────────────────────────────────────────────────────────────────
const judgeGap = computed(() =>
  needs.value.judgeKeys.length ? providerGap(needs.value.judgeProvider) : null,
);
const rescoreReason = computed(() => {
  if (needs.value.noJudgeModelReason) return needs.value.noJudgeModelReason;
  const gap = judgeGap.value;
  return gap
    ? `Re-score needs ${gap.name} for the ${needs.value.judgeKeys.join(' and ')} judge.`
    : null;
});
const rescorePrimary = computed(() => props.detail.outcomeNotice?.kind === 'error');

// ── Retry execution ─────────────────────────────────────────────────────────
const retryGap = computed(() => providerGap(needs.value.provider));
const retryReason = computed(() => {
  if (props.detail.attemptCount >= MAX_ATTEMPTS) {
    return `This run has had ${MAX_ATTEMPTS} attempts, the most a run can have.`;
  }
  return retryGap.value ? `Retry needs ${retryGap.value.name}.` : null;
});

// ── running the actions ─────────────────────────────────────────────────────
const busy = ref<'rescore' | 'retry' | 'cancel' | null>(null);
const cancelError = ref<string | null>(null);
const confirming = ref(false);

async function rescore(): Promise<void> {
  if (busy.value || rescoreReason.value) return;
  busy.value = 'rescore';
  try {
    const result = await store.rescore(props.detail.id);
    const g = result.evaluation.generation;
    emit(
      'done',
      result.joinedPending
        ? `Joined the re-score already queued (generation ${g}).`
        : `Re-score queued as generation ${g}. The scores below stay current until it publishes.`,
    );
  } catch (err) {
    emit('failed', errorMessage(err));
  } finally {
    busy.value = null;
  }
}

async function retry(): Promise<void> {
  if (busy.value || retryReason.value) return;
  busy.value = 'retry';
  try {
    const result = await store.retry(props.detail.id);
    emit('done', result.attempt ? `Retry queued as attempt ${result.attempt}.` : 'Retry queued.');
  } catch (err) {
    emit('failed', errorMessage(err));
  } finally {
    busy.value = null;
  }
}

async function cancel(): Promise<void> {
  busy.value = 'cancel';
  cancelError.value = null;
  try {
    await store.cancel(props.detail.id);
    emit(
      'done',
      status.value === 'running' ? 'Cancel requested: the worker stops the run.' : 'Run cancelled.',
    );
  } catch (err) {
    cancelError.value = errorMessage(err);
  } finally {
    busy.value = null;
  }
}

const systemRoute = { name: ROUTE_NAMES.system };
</script>

<template>
  <div class="flex flex-wrap items-start justify-end gap-6" data-testid="run-actions">
    <template v-if="status === 'scored'">
      <BaseTooltip
        v-if="counterpart"
        :text="jumpReason"
        :enabled="!!jumpReason"
        v-slot="{ describedBy }"
      >
        <button
          type="button"
          class="btn mid"
          :aria-disabled="jumpReason ? 'true' : undefined"
          :aria-description="jumpReason ?? undefined"
          :aria-describedby="describedBy"
          :title="jumpReason ? undefined : 'Same task, same repetition, other configuration'"
          data-testid="ab-jump"
          @click="jump"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M2 4.5h9M8.5 2l2.5 2.5L8.5 7M12 9.5H3M5.5 7L3 9.5 5.5 12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Same task under <span class="font-mono">{{ counterpart.configuration }}</span>
        </button>
      </BaseTooltip>
      <BlockedReason
        :class="{ 'order-last basis-full justify-end': rescoreReason }"
        :blocked="!!rescoreReason"
        :reason="rescoreReason ?? ''"
        layout="inline"
        :fix-label="
          judgeGap && !needs.noJudgeModelReason
            ? judgeGap.connect
              ? 'Connect'
              : 'How to add it'
            : null
        "
        :fix-to="judgeGap && !judgeGap.connect ? systemRoute : null"
        :connect-origin="judgeGap?.connect ? 'other' : null"
      >
        <template #default="{ attrs }">
          <button
            type="button"
            class="btn mid"
            :class="{ primary: rescorePrimary }"
            v-bind="attrs"
            :disabled="busy !== null || !!rescoreReason"
            :aria-busy="busy === 'rescore' || undefined"
            data-testid="rescore"
            @click="rescore"
          >
            {{ busy === 'rescore' ? 'Re-scoring…' : 'Re-score' }}
          </button>
        </template>
        <template v-if="!needs.noJudgeModelReason && judgeGap" #reason>
          Re-score needs {{ judgeGap.name }} for the
          <template v-for="(key, i) in needs.judgeKeys" :key="key"
            >{{ i ? ' and ' : '' }}<code class="font-mono">{{ key }}</code></template
          >
          judge.
        </template>
      </BlockedReason>
    </template>

    <BlockedReason
      v-if="status === 'execution_error'"
      :class="{ 'order-last basis-full justify-end': retryReason }"
      :blocked="!!retryReason"
      :reason="retryReason ?? ''"
      layout="inline"
      :fix-label="
        retryGap && detail.attemptCount < 5
          ? retryGap.connect
            ? 'Connect'
            : 'How to add it'
          : null
      "
      :fix-to="retryGap && !retryGap.connect ? systemRoute : null"
      :connect-origin="retryGap?.connect ? 'other' : null"
      v-slot="{ attrs }"
    >
      <button
        type="button"
        class="btn primary mid"
        v-bind="attrs"
        :disabled="busy !== null || !!retryReason"
        :aria-busy="busy === 'retry' || undefined"
        data-testid="retry"
        @click="retry"
      >
        {{ busy === 'retry' ? 'Retrying…' : 'Retry execution' }}
      </button>
    </BlockedReason>

    <ConfirmInline
      v-if="status === 'queued' || status === 'running'"
      v-model:open="confirming"
      trigger-label="Cancel run"
      trigger-variant="default"
      title="Cancel this run?"
      consequence="It stops now and is kept for the record. A cancelled run is not scored and does not count toward pass rates."
      confirm-label="Cancel run"
      cancel-label="Keep running"
      busy-label="Cancelling…"
      layout="row"
      button-size="mid"
      error-title="Could not cancel. The run goes on."
      :busy="busy === 'cancel'"
      :error="cancelError"
      @confirm="cancel"
      @cancel="cancelError = null"
    />

    <CopyButton
      v-if="!confirming"
      variant="button"
      :text="detail.id"
      :label="`Copy run id ${detail.id}`"
      button-text="Copy run id"
    />
  </div>
</template>

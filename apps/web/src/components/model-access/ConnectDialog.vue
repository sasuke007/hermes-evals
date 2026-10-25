<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import CopyCommand from '@/components/ui/CopyCommand.vue';
import BaseDialog from '@/components/ui/BaseDialog.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import { TONE_CLASSES, type Tone } from '@/lib/statusTones';
import { LOGIN_OUTCOMES, canSimulateLogin, type LoginOutcome } from '@/api/providers';
import { useProvidersStore, type FollowUpAction } from '@/stores/providers';
import { NOUS_TERMINAL_LOGIN_COMMAND } from './nousCommands';

/**
 * The Nous Portal device login as an in-page modal (role="dialog", aria-modal) over a scrim.
 * Mounted once in App.vue and driven by the providers store: open it with
 * providers.connect(origin, onFollowUp, context).
 *
 * Steps: Requesting → Waiting (code, Copy, Open Nous Portal ↗, countdown, four steps, Cancel
 * login) → Connected. Ends: Expired, Declined, Needs subscription, Failed, each with one retry
 * action. Esc, × and the scrim close it; a waiting login keeps going (ApprovalPill reopens it).
 * Connected offers a follow-up that depends on the origin; it never launches or resumes itself.
 * Manual: the stack cannot log Nous in from here (the development host proxy is down, or the
 * login service is unavailable), so the dialog shows the System row's sentence and the
 * terminal command instead of asking the API for a code.
 */
const props = withDefaults(
  defineProps<{
    /** Show the fixture controls that end a waiting login (development + fixtures only). */
    devControls?: boolean | null;
  }>(),
  { devControls: null },
);

const providers = useProvidersStore();
const dialog = ref<InstanceType<typeof BaseDialog> | null>(null);

const phase = computed(() => providers.loginPhase);
const showDev = computed(() => props.devControls ?? (import.meta.env.DEV && canSimulateLogin));

interface Problem {
  tone: Extract<Tone, 'que' | 'ung' | 'fail'>;
  glyph: string;
  lead: string;
  body: string;
  action: string;
  billing?: boolean;
}
const problem = computed<Problem | null>(() => {
  switch (phase.value) {
    case 'expired':
      return {
        tone: 'que',
        glyph: '!',
        lead: 'The code expired before it was approved.',
        body: 'Get a new code and approve it in Nous Portal.',
        action: 'Get a new code',
      };
    case 'declined':
      return {
        tone: 'que',
        glyph: '✕',
        lead: 'The login was declined in Nous Portal.',
        body: 'Nothing was connected. Try again if that was a mistake.',
        action: 'Try again',
      };
    case 'subscription':
      return {
        tone: 'ung',
        glyph: '!',
        lead: 'This Nous account has no active subscription.',
        body: 'Add a subscription in Nous Portal, then connect again.',
        action: 'Open Nous Portal billing ↗',
        billing: true,
      };
    case 'failed':
      return {
        tone: 'fail',
        glyph: '!',
        lead: providers.loginError ?? 'Could not reach Nous Portal: connection timed out.',
        body: 'Check that the stack can reach the internet through the egress service, then try again.',
        action: 'Try again',
      };
    default:
      return null;
  }
});

/** The manual step: the System row's sentence for the status, and the command to run. */
const manual = computed(() => {
  if (phase.value !== 'manual') return null;
  if (providers.nous?.status === 'host_unreachable') {
    return {
      tone: 'ung' as const,
      lead: "This stack uses this machine's Hermes login, but its proxy is not running.",
      body: 'Start it in a terminal:',
      command: providers.nous.hostCommand ?? 'hermes proxy start --provider nous',
    };
  }
  return {
    tone: 'fail' as const,
    lead: 'The login service failed its startup check: this Hermes version does not offer the device login the platform uses.',
    body: 'Connect from a terminal instead:',
    command: NOUS_TERMINAL_LOGIN_COMMAND,
  };
});

const connectedText = computed(() => {
  const { experimentName, scored, total } = providers.context;
  switch (providers.origin) {
    case 'new-experiment':
      return `${experimentName || 'Your experiment'} can launch now. Your form is unchanged.`;
    case 'paused-experiment':
      if (experimentName && scored !== null && scored !== undefined && total) {
        return `${experimentName} is still paused at ${scored} of ${total}.`;
      }
      return `${experimentName || 'The experiment'} is still paused.`;
    default:
      return 'Every configuration that uses Nous Portal can now run.';
  }
});

const outcomeLabels: Record<LoginOutcome, string> = {
  approve: 'Approved',
  decline: 'Declined',
  expire: 'Expired',
  subscription: 'No subscription',
  fail: 'Failed',
};

/** The glyph's 1.5px ring in the problem's tone. */
const GLYPH_RING: Record<Problem['tone'], string> = {
  que: 'inset-ring-que',
  ung: 'inset-ring-ung',
  fail: 'inset-ring-fail',
};

function close(): void {
  providers.closeDialog();
}
function follow(action: FollowUpAction): void {
  providers.followUp(action);
}

// The step changed under the user (requesting → waiting → connected): the old button is gone.
watch(phase, () => {
  if (providers.dialogOpen) void dialog.value?.focusStart();
});
</script>

<template>
  <BaseDialog
    ref="dialog"
    :open="providers.dialogOpen"
    :title="providers.dialogHeading"
    :data-phase="phase"
    :body-class="
      phase === 'requesting' || phase === 'idle'
        ? 'flex flex-col items-center gap-14 px-16 py-40'
        : null
    "
    @close="close"
  >
    <!-- Requesting -->
    <template v-if="phase === 'requesting' || phase === 'idle'">
      <div class="flex flex-col items-center gap-14" role="status">
        <span
          class="size-20 animate-spin rounded-full border-2 border-accent border-r-transparent"
          aria-hidden="true"
        />
        <span class="text-text-2">Asking Nous Portal for a code…</span>
      </div>
    </template>

    <!-- Waiting -->
    <template v-else-if="phase === 'waiting'">
      <div class="flex flex-col items-start gap-6">
        <span class="text-12 text-text-3">Your code</span>
        <div class="flex items-center gap-10">
          <span
            class="font-mono text-[30px] leading-[38px] font-semibold tracking-[0.08em]"
            data-testid="user-code"
            >{{ providers.userCode }}</span
          >
          <CopyButton
            variant="button"
            :text="providers.userCode ?? ''"
            label="Copy code"
            button-text="Copy"
          />
        </div>
        <span
          class="inline-flex items-center gap-6 text-12 leading-20 text-run-text"
          role="timer"
          aria-live="off"
          ><StatusDot tone="run" mode="pulse" /><span class="font-mono"
            >{{ providers.countdown }} left</span
          ></span
        >
      </div>
      <a
        class="btn primary self-start"
        :href="providers.verifyUrl ?? '#'"
        target="_blank"
        rel="noopener noreferrer"
        data-primary
        >Open Nous Portal ↗</a
      >
      <ol class="flex list-decimal flex-col gap-4 pl-20 text-text-2">
        <li>Click Open Nous Portal.</li>
        <li>Sign in to Nous Portal.</li>
        <li>Check the code matches, then approve.</li>
        <li>Come back here. This updates by itself.</li>
      </ol>
      <button type="button" class="linkbtn self-start text-12" @click="providers.cancel()">
        Cancel login
      </button>
      <div
        v-if="showDev"
        class="flex flex-wrap items-center gap-6 rounded-4 border border-dashed border-border-strong px-10 py-8"
        role="group"
        aria-label="Fixture controls, development only"
      >
        <span class="text-12 text-text-3">Fixtures, dev only: end this login as</span>
        <button
          v-for="outcome in LOGIN_OUTCOMES"
          :key="outcome"
          type="button"
          class="btn sm"
          :data-outcome="outcome"
          @click="providers.simulate(outcome)"
        >
          {{ outcomeLabels[outcome] }}
        </button>
      </div>
    </template>

    <!-- Connected -->
    <template v-else-if="phase === 'connected'">
      <div
        class="flex items-start gap-10 rounded-6 border border-pass bg-pass-soft px-14 py-12"
        role="status"
      >
        <svg
          class="flex-none text-pass-text"
          width="18"
          height="18"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M5 8.3l2 2 4-4.3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <div class="flex flex-col gap-2">
          <b class="text-pass-text">Nous Portal is connected.</b>
          <span class="text-text-2">{{ connectedText }}</span>
        </div>
      </div>
    </template>

    <!-- Manual: host proxy down, or the login service unavailable -->
    <template v-else-if="manual">
      <div
        class="flex items-start gap-10 rounded-6 border px-14 py-12"
        :class="[TONE_CLASSES[manual.tone].soft, TONE_CLASSES[manual.tone].border]"
        role="alert"
      >
        <span
          class="inline-flex size-18 flex-none items-center justify-center rounded-full text-11 font-bold inset-ring-[1.5px]"
          :class="[TONE_CLASSES[manual.tone].text, GLYPH_RING[manual.tone]]"
          aria-hidden="true"
          >!</span
        >
        <div class="flex min-w-0 flex-col gap-6">
          <b :class="TONE_CLASSES[manual.tone].text">{{ manual.lead }}</b>
          <span class="text-text-2">{{ manual.body }}</span>
          <CopyCommand class="self-start" :command="manual.command" />
        </div>
      </div>
    </template>

    <!-- Expired · Declined · Needs subscription · Failed -->
    <template v-else-if="problem">
      <div
        class="flex items-start gap-10 rounded-6 border px-14 py-12"
        :class="[TONE_CLASSES[problem.tone].soft, TONE_CLASSES[problem.tone].border]"
        role="alert"
      >
        <span
          class="inline-flex size-18 flex-none items-center justify-center rounded-full text-11 font-bold inset-ring-[1.5px]"
          :class="[TONE_CLASSES[problem.tone].text, GLYPH_RING[problem.tone]]"
          aria-hidden="true"
          >{{ problem.glyph }}</span
        >
        <div class="flex flex-col gap-2">
          <b :class="TONE_CLASSES[problem.tone].text">{{ problem.lead }}</b>
          <span class="text-text-2">{{ problem.body }}</span>
        </div>
      </div>
    </template>

    <template v-if="phase === 'waiting'" #note>
      You can close this window; the login keeps waiting in the background.
    </template>

    <template v-if="phase !== 'waiting'" #footer>
      <button
        v-if="phase === 'requesting' || phase === 'idle'"
        type="button"
        class="btn ghost"
        data-primary
        @click="providers.cancel()"
      >
        Cancel
      </button>
      <template v-else-if="phase === 'connected'">
        <template v-if="providers.origin === 'new-experiment'">
          <button type="button" class="btn" @click="follow('back')">Back to the form</button>
          <button type="button" class="btn primary" data-primary @click="follow('launch')">
            Launch now
          </button>
        </template>
        <template v-else-if="providers.origin === 'paused-experiment'">
          <button type="button" class="btn" @click="close">Close</button>
          <button type="button" class="btn primary" data-primary @click="follow('resume')">
            Resume experiment
          </button>
        </template>
        <button v-else type="button" class="btn primary" data-primary @click="follow('done')">
          Done
        </button>
      </template>
      <button v-else-if="manual" type="button" class="btn primary" data-primary @click="close">
        Close
      </button>
      <template v-else-if="problem">
        <button type="button" class="btn ghost" @click="close">Close</button>
        <a
          v-if="problem.billing"
          class="btn primary"
          :href="providers.billingUrl ?? '#'"
          target="_blank"
          rel="noopener noreferrer"
          data-primary
          >{{ problem.action }}</a
        >
        <button v-else type="button" class="btn primary" data-primary @click="providers.retry()">
          {{ problem.action }}
        </button>
      </template>
    </template>
  </BaseDialog>
</template>

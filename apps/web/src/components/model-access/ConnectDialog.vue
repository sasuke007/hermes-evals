<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import { LOGIN_OUTCOMES, canSimulateLogin, type LoginOutcome } from '@/api/providers';
import { useProvidersStore, type FollowUpAction } from '@/stores/providers';

/**
 * The Nous Portal device login as an in-page modal (role="dialog", aria-modal) over a scrim.
 * Mounted once in App.vue and driven by the providers store: open it with
 * providers.connect(origin, onFollowUp, context).
 *
 * Steps: Requesting → Waiting (code, Copy, Open Nous Portal ↗, countdown, four steps, Cancel
 * login) → Connected. Ends: Expired, Declined, Needs subscription, Failed, each with one retry
 * action. Esc, × and the scrim close it; a waiting login keeps going (ApprovalPill reopens it).
 * Connected offers a follow-up that depends on the origin; it never launches or resumes itself.
 */
const props = withDefaults(
  defineProps<{
    /** Show the fixture controls that end a waiting login (development + fixtures only). */
    devControls?: boolean | null;
  }>(),
  { devControls: null },
);

const providers = useProvidersStore();
const headingId = `connect-${useId()}`;
const dialogEl = ref<HTMLElement | null>(null);
let restoreFocus: HTMLElement | null = null;

const phase = computed(() => providers.loginPhase);
const showDev = computed(() => props.devControls ?? (import.meta.env.DEV && canSimulateLogin));

interface Problem {
  tone: 'que' | 'ung' | 'fail';
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

function close(): void {
  providers.closeDialog();
}
function follow(action: FollowUpAction): void {
  providers.followUp(action);
}

// ── focus: start on the primary button, trap Tab, restore on close ───────
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  return dialogEl.value ? Array.from(dialogEl.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
}

async function focusPrimary(): Promise<void> {
  await nextTick();
  const el = dialogEl.value;
  if (!el) return;
  const target = el.querySelector<HTMLElement>('[data-primary]') ?? focusables()[0] ?? el;
  target.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables();
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialogEl.value?.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => providers.dialogOpen,
  (open, wasOpen) => {
    if (open && !wasOpen) {
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      restoreFocus = active instanceof HTMLElement && active !== document.body ? active : null;
      void focusPrimary();
    } else if (!open && wasOpen) {
      const target = restoreFocus;
      restoreFocus = null;
      if (target?.isConnected) target.focus();
    }
  },
  { immediate: true },
);
// The step changed under the user (requesting → waiting → connected): the old button is gone.
watch(phase, () => {
  if (providers.dialogOpen) void focusPrimary();
});
onBeforeUnmount(() => {
  restoreFocus = null;
});
</script>

<template>
  <div v-if="providers.dialogOpen" class="cd-scrim" @mousedown.self="close">
    <div
      ref="dialogEl"
      class="dlg cd"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="headingId"
      tabindex="-1"
      :data-phase="phase"
      @keydown="onKeydown"
    >
      <div class="dlg-h">
        <span :id="headingId" class="cd-heading">{{ providers.dialogHeading }}</span>
        <button type="button" class="btn ghost cd-close" aria-label="Close" @click="close">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M3.5 3.5l7 7M10.5 3.5l-7 7"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <!-- Requesting -->
      <template v-if="phase === 'requesting' || phase === 'idle'">
        <div class="dlg-b cd-requesting" role="status">
          <span class="cd-spinner" aria-hidden="true" />
          <span class="t2">Asking Nous Portal for a code…</span>
        </div>
        <div class="dlg-f">
          <button type="button" class="btn ghost" data-primary @click="providers.cancel()">
            Cancel
          </button>
        </div>
      </template>

      <!-- Waiting -->
      <template v-else-if="phase === 'waiting'">
        <div class="dlg-b">
          <div class="cd-code-block">
            <span class="cap">Your code</span>
            <div class="cd-code-row">
              <span class="mono cd-code" data-testid="user-code">{{ providers.userCode }}</span>
              <CopyButton
                variant="button"
                :text="providers.userCode ?? ''"
                label="Copy code"
                button-text="Copy"
              />
            </div>
            <span class="cd-left" role="timer" aria-live="off"
              ><span class="dot pulse tone-run" aria-hidden="true" /><span class="mono"
                >{{ providers.countdown }} left</span
              ></span
            >
          </div>
          <a
            class="btn primary cd-open"
            :href="providers.verifyUrl ?? '#'"
            target="_blank"
            rel="noopener noreferrer"
            data-primary
            >Open Nous Portal ↗</a
          >
          <ol class="t2 cd-steps">
            <li>Click Open Nous Portal.</li>
            <li>Sign in to Nous Portal.</li>
            <li>Check the code matches, then approve.</li>
            <li>Come back here. This updates by itself.</li>
          </ol>
          <button type="button" class="linkbtn cd-cancel" @click="providers.cancel()">
            Cancel login
          </button>
          <div
            v-if="showDev"
            class="cd-dev"
            role="group"
            aria-label="Fixture controls, development only"
          >
            <span class="cap">Fixtures, dev only: end this login as</span>
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
        </div>
        <div class="cap cd-note">
          You can close this window; the login keeps waiting in the background.
        </div>
      </template>

      <!-- Connected -->
      <template v-else-if="phase === 'connected'">
        <div class="dlg-b">
          <div class="cd-box tone-pass" role="status">
            <svg class="cd-check" width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
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
            <div class="cd-box-text">
              <b class="cd-lead">Nous Portal is connected.</b>
              <span class="t2">{{ connectedText }}</span>
            </div>
          </div>
        </div>
        <div class="dlg-f">
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
        </div>
      </template>

      <!-- Expired · Declined · Needs subscription · Failed -->
      <template v-else-if="problem">
        <div class="dlg-b">
          <div class="cd-box" :class="`tone-${problem.tone}`" role="alert">
            <span class="cd-glyph" aria-hidden="true">{{ problem.glyph }}</span>
            <div class="cd-box-text">
              <b class="cd-lead">{{ problem.lead }}</b>
              <span class="t2">{{ problem.body }}</span>
            </div>
          </div>
        </div>
        <div class="dlg-f">
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
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cd-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: var(--scrim);
  overflow-y: auto;
}
.cd:focus {
  outline: none;
}
.cd-heading {
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
}
.cd-close {
  height: 28px;
  padding: 0 6px;
}
.cd-requesting {
  align-items: center;
  padding: 40px 16px;
}
.cd-spinner {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  border-right-color: transparent;
  animation: he-spin 0.9s linear infinite;
}
.cd-code-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.cd-code-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cd-code {
  font-size: 30px;
  line-height: 38px;
  font-weight: 600;
  letter-spacing: 0.08em;
}
.cd-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--run-text);
}
.cd-open,
.cd-cancel {
  align-self: flex-start;
}
.cd-cancel {
  font-size: 12px;
}
.cd-steps {
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cd-note {
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}
.cd-dev {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: 4px;
}
.cd-box {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: 6px;
  background: var(--tone-soft);
  border: 1px solid var(--tone);
}
.cd-check {
  flex: none;
  color: var(--tone-text);
}
.cd-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  color: var(--tone-text);
  box-shadow: inset 0 0 0 1.5px var(--tone);
}
.cd-box-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cd-lead {
  color: var(--tone-text);
}
</style>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';

/**
 * A confirmation step drawn in the page (browser dialogs are never used). The trigger is
 * replaced in place by a panel that states the consequence in numbers. Focus moves to the safe
 * option; Esc backs out. The parent performs the action on `confirm` and sets `busy` (the
 * confirm button then shows a spinner and busyLabel, both buttons disabled).
 *
 * When busy goes back to false: without `error` the panel closes and focus returns to the
 * trigger; with `error` the panel stays open with the server message verbatim in place of the
 * consequence, and the confirm button reads "Try again" (Components 1, ConfirmInline failed).
 * The safe option closes it and the trigger returns.
 *
 * Without `triggerLabel` (and no #trigger slot) nothing is drawn until `v-model:open` is set
 * by the parent, as on System, where the confirmation expands under the provider row.
 *
 * #consequence replaces the consequence's text (OverviewRunning sets `cancelled` in mono).
 */
const props = withDefaults(
  defineProps<{
    /** Text of the button this component replaces while confirming. */
    triggerLabel?: string | null;
    /** Button style of the trigger. Defaults to danger for tone="danger". */
    triggerVariant?: 'default' | 'primary' | 'ghost' | 'danger' | null;
    /** A question with the number in it: "Cancel 32 unfinished runs?" */
    title: string;
    /** One or two sentences on what is lost and what is kept. */
    consequence?: string | null;
    /** Repeats the verb: "Cancel experiment", "Disconnect". */
    confirmLabel: string;
    /** The safe option; takes focus. "Keep running", "Keep connected". */
    cancelLabel?: string;
    tone?: 'danger' | 'default';
    /** Disables both buttons and shows busyLabel on the confirm button. */
    busy?: boolean;
    /** "Cancelling…". Defaults to the confirm label followed by an ellipsis. */
    busyLabel?: string | null;
    /** Verbatim server message after a failed attempt: the panel stays open and shows it. */
    error?: string | null;
    /** The bold line above the message: "Could not cancel. Nothing was stopped." */
    errorTitle?: string;
    /** The confirm button after a failure. */
    retryLabel?: string;
    /**
     * stacked: title, consequence, buttons (Components 1) · row: one run of text left, buttons
     * right (System, ModelAccessStates) · columns: a text column of at most 820px, the title on
     * its own line and the consequence under it, buttons right (OverviewRunning).
     */
    layout?: 'stacked' | 'row' | 'columns';
    /** Button height: md 32px (default) or mid 28px (System, ModelAccessStates). */
    buttonSize?: 'md' | 'mid';
    /** aria-label of the group. Defaults to the title. */
    label?: string | null;
    /** No border, fill or padding: the container draws them (System's tinted table row). */
    bare?: boolean;
  }>(),
  {
    triggerLabel: null,
    triggerVariant: null,
    consequence: null,
    cancelLabel: 'Cancel',
    tone: 'danger',
    busy: false,
    busyLabel: null,
    error: null,
    errorTitle: 'That did not work',
    retryLabel: 'Try again',
    layout: 'stacked',
    buttonSize: 'md',
    label: null,
    bare: false,
  },
);
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const open = defineModel<boolean>('open', { default: false });

const triggerEl = ref<HTMLButtonElement | null>(null);
const cancelEl = ref<HTMLButtonElement | null>(null);
const groupId = useId();

const failed = computed(() => !!props.error && !props.busy);
const mid = computed(() => (props.buttonSize === 'mid' ? 'mid' : ''));
const triggerClass = computed(() => {
  const variant = props.triggerVariant ?? (props.tone === 'danger' ? 'danger' : 'default');
  return ['btn', variant === 'default' ? '' : variant, mid.value];
});
const confirmClass = computed(() => [
  'btn',
  props.tone === 'danger' ? 'danger' : 'primary',
  mid.value,
]);
/** The title and consequence run on in one line of text. */
const inline = computed(() => props.layout === 'row');
const LAYOUT = {
  stacked: { group: 'flex-col gap-10', pad: 'p-14', text: 'flex flex-col gap-10', gap: 'gap-8' },
  row: {
    group: 'flex-wrap items-center justify-between gap-x-20 gap-y-10',
    pad: 'px-16 py-10',
    text: '',
    gap: 'gap-6',
  },
  columns: {
    group: 'flex-wrap items-center justify-between gap-x-24 gap-y-12',
    pad: 'px-16 py-14',
    text: 'flex min-w-0 max-w-820 flex-col gap-2',
    gap: 'gap-8',
  },
} as const;
const look = computed(() => LAYOUT[props.layout]);
/** bare leaves the border, fill and padding to the container. */
const groupClass = computed(() => [
  look.value.group,
  props.bare
    ? ''
    : [
        'rounded-6 border',
        look.value.pad,
        props.tone === 'danger' ? 'border-fail bg-fail-soft' : 'border-border-strong bg-surface-2',
      ],
]);

async function start(): Promise<void> {
  open.value = true;
  await nextTick();
  cancelEl.value?.focus();
}

async function back(): Promise<void> {
  if (props.busy) return;
  open.value = false;
  emit('cancel');
  await nextTick();
  triggerEl.value?.focus();
}

function confirm(): void {
  if (props.busy) return;
  emit('confirm');
}

// Opened by the parent (no trigger): move focus to the safe option as well.
watch(open, async (value, previous) => {
  if (value && !previous) {
    await nextTick();
    if (document.activeElement !== cancelEl.value) cancelEl.value?.focus();
  }
});

// The parent finished the action: close and return the trigger, unless it failed.
watch(
  () => props.busy,
  async (busy, wasBusy) => {
    if (!wasBusy || busy) return;
    if (props.error) {
      // Failed: stay open with the message; the safe option takes focus again.
      await nextTick();
      cancelEl.value?.focus();
      return;
    }
    open.value = false;
    await nextTick();
    triggerEl.value?.focus();
  },
);

defineExpose({ start, close: back });
</script>

<template>
  <div class="flex min-w-0 flex-col gap-12">
    <template v-if="!open">
      <slot name="trigger" :open="start">
        <button
          v-if="triggerLabel"
          ref="triggerEl"
          type="button"
          :class="triggerClass"
          @click="start"
        >
          {{ triggerLabel }}
        </button>
      </slot>
    </template>
    <div
      v-else
      :id="groupId"
      role="group"
      :aria-label="label ?? title"
      :aria-busy="busy || undefined"
      class="flex"
      :class="groupClass"
      :data-layout="layout"
      :data-tone="tone"
      @keydown.esc.stop.prevent="back"
    >
      <div :class="look.text" data-testid="confirm-text">
        <b class="font-semibold" :class="tone === 'danger' ? 'text-fail-text' : 'text-text'">{{
          title
        }}</b>
        <template v-if="(consequence || $slots.consequence) && !failed">
          <template v-if="inline">{{ ' ' }}</template
          ><span class="text-text-2" data-testid="confirm-consequence"
            ><slot name="consequence">{{ consequence }}</slot></span
          >
        </template>
        <div
          v-if="failed && layout === 'stacked'"
          class="flex flex-col gap-4 rounded-4 border border-fail bg-surface px-12 py-10"
          role="alert"
          data-testid="confirm-error"
        >
          <b class="text-fail-text">{{ errorTitle }}</b>
          <code class="whitespace-normal text-text-2">{{ error }}</code>
        </div>
      </div>
      <div class="flex" :class="look.gap">
        <button
          type="button"
          :class="confirmClass"
          :disabled="busy"
          :aria-busy="busy || undefined"
          @click="confirm"
        >
          <span
            v-if="busy"
            class="size-10 flex-none animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
            aria-hidden="true"
          />
          {{ busy ? (busyLabel ?? `${confirmLabel}…`) : failed ? retryLabel : confirmLabel }}
        </button>
        <button
          ref="cancelEl"
          type="button"
          class="btn"
          :class="mid"
          :disabled="busy"
          @click="back"
        >
          {{ cancelLabel }}
        </button>
      </div>
      <div
        v-if="failed && layout !== 'stacked'"
        class="flex basis-full flex-col gap-4 rounded-4 border border-fail bg-surface px-12 py-10"
        role="alert"
        data-testid="confirm-error"
      >
        <b class="text-fail-text">{{ errorTitle }}</b>
        <code class="whitespace-normal text-text-2">{{ error }}</code>
      </div>
    </div>
  </div>
</template>

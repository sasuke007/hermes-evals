<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import ErrorBanner from './ErrorBanner.vue';

/**
 * A confirmation step drawn in the page (browser dialogs are not available). The trigger is
 * replaced in place by a panel that states the consequence in numbers. Focus moves to the safe
 * option; Esc backs out. The parent performs the action on `confirm` and sets `busy`; when busy
 * goes back to false the panel closes and, if `error` is set, an ErrorBanner shows under the
 * returned trigger.
 *
 * Without `triggerLabel` (and no #trigger slot) nothing is drawn until `v-model:open` is set
 * by the parent, as on System, where the confirmation expands under the provider row.
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
    /** Verbatim server message after a failed attempt. */
    error?: string | null;
    errorTitle?: string;
    /** stacked: title, consequence, buttons (Components 1) · row: text left, buttons right. */
    layout?: 'stacked' | 'row';
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

const triggerClass = computed(() => {
  const variant = props.triggerVariant ?? (props.tone === 'danger' ? 'danger' : 'default');
  return ['btn', variant === 'default' ? '' : variant, props.buttonSize === 'mid' ? 'mid' : ''];
});
const confirmClass = computed(() => [
  'btn',
  props.tone === 'danger' ? 'danger' : 'primary',
  props.buttonSize === 'mid' ? 'mid' : '',
]);
const cancelClass = computed(() => ['btn', props.buttonSize === 'mid' ? 'mid' : '']);

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

// The parent finished the action: close, and let the trigger (and any error) return.
watch(
  () => props.busy,
  async (busy, wasBusy) => {
    if (wasBusy && !busy) {
      open.value = false;
      await nextTick();
      triggerEl.value?.focus();
    }
  },
);

defineExpose({ start, close: back });
</script>

<template>
  <div class="confirm-inline">
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
      class="ci-group"
      :class="[`tone-${tone}`, `layout-${layout}`, { bare }]"
      @keydown.esc.stop.prevent="back"
    >
      <div class="ci-text">
        <b class="ci-title">{{ title }}</b>
        <template v-if="consequence">
          {{ ' ' }}<span class="t2 ci-consequence">{{ consequence }}</span>
        </template>
      </div>
      <div class="ci-buttons">
        <button
          type="button"
          :class="confirmClass"
          :disabled="busy"
          :aria-busy="busy || undefined"
          @click="confirm"
        >
          {{ busy ? (busyLabel ?? `${confirmLabel}…`) : confirmLabel }}
        </button>
        <button ref="cancelEl" type="button" :class="cancelClass" :disabled="busy" @click="back">
          {{ cancelLabel }}
        </button>
      </div>
    </div>
    <ErrorBanner
      v-if="error && !open"
      class="ci-error"
      tone="error"
      :title="errorTitle"
      :detail="error"
    />
  </div>
</template>

<style scoped>
.confirm-inline {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.ci-group {
  display: flex;
  border-radius: 6px;
  border: 1px solid var(--ci-border);
  background: var(--ci-bg);
}
.tone-danger {
  --ci-border: var(--fail);
  --ci-bg: var(--fail-soft);
  --ci-title: var(--fail-text);
}
.tone-default {
  --ci-border: var(--border-strong);
  --ci-bg: var(--surface-2);
  --ci-title: var(--text);
}
.layout-stacked {
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}
.layout-stacked .ci-text {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.layout-row {
  flex-wrap: wrap;
  gap: 10px 20px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
}
.ci-group.bare {
  border: 0;
  background: none;
  padding: 0;
  border-radius: 0;
}
.ci-title {
  font-weight: 600;
  color: var(--ci-title);
}
.ci-buttons {
  display: flex;
  gap: 8px;
}
.layout-row .ci-buttons {
  gap: 6px;
}
</style>

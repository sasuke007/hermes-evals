<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useFocusTrap } from '@/composables/useFocusTrap';

/**
 * An in-page modal (role="dialog", aria-modal) over a scrim: ConnectDialog, the upload
 * dialogs. Browser dialogs are never used. Focus starts on the [data-primary] element (else
 * the first control), Tab stays inside, and closing returns focus to the opener. Esc, × and
 * the scrim close it unless `dismissible` is false.
 *
 * Parts: header (title, #header-extra such as "Step 2 of 2 · Validate", ×) · body (the
 * default slot, 18px 16px padding, 14px gaps) · #footer (actions, right-aligned) · #note
 * (a caption row under the body). Extra attributes land on the dialog element.
 */
defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** The heading, also the dialog's accessible name. */
    title: string;
    /** Max width in px. */
    width?: number;
    /** Esc, × and the scrim close it. */
    dismissible?: boolean;
    /** Where focus starts: a selector inside the dialog. */
    initialFocus?: string;
    /** Replaces the body padding and gaps (the default slot is still inside it). */
    bodyClass?: string | null;
  }>(),
  { width: 560, dismissible: true, initialFocus: '[data-primary]', bodyClass: null },
);
const emit = defineEmits<{ close: [] }>();
const open = defineModel<boolean>('open', { default: false });

const headingId = `dialog-${useId()}`;
const dialogEl = ref<HTMLElement | null>(null);

function close(): void {
  if (!props.dismissible) return;
  open.value = false;
  emit('close');
}

const { onKeydown, focusStart } = useFocusTrap(dialogEl, {
  active: open,
  onEscape: close,
  initialFocus: props.initialFocus,
});

const bodyClasses = computed(() => props.bodyClass ?? 'flex flex-col gap-14 px-16 py-18');

defineExpose({ focusStart });
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-scrim px-16 py-24"
    data-testid="dialog-scrim"
    @mousedown.self="close"
  >
    <div
      ref="dialogEl"
      v-bind="$attrs"
      class="flex w-full flex-col rounded-8 border border-border bg-surface shadow-float focus:outline-none"
      :style="{ maxWidth: `${width}px` }"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="headingId"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <div class="flex items-center justify-between gap-12 border-b border-border px-16 py-14">
        <h2 :id="headingId" class="text-15 font-semibold">
          <slot name="title">{{ title }}</slot>
        </h2>
        <div class="flex items-center gap-8">
          <slot name="header-extra" />
          <button
            v-if="dismissible"
            type="button"
            class="btn ghost h-28 px-6"
            aria-label="Close"
            @click="close"
          >
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
      </div>
      <div :class="bodyClasses"><slot /></div>
      <div
        v-if="$slots.note"
        class="border-t border-border px-16 py-10 text-12 text-text-3"
        data-testid="dialog-note"
      >
        <slot name="note" />
      </div>
      <div
        v-if="$slots.footer"
        class="flex justify-end gap-8 border-t border-border px-16 py-12"
        data-testid="dialog-footer"
      >
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

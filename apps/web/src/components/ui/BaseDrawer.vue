<script setup lang="ts">
import { ref, useId } from 'vue';
import { useEventListener } from '@vueuse/core';
import { useFocusTrap } from '@/composables/useFocusTrap';

/**
 * A right-hand drawer over the page that opened it (the run inspector): 75% of the window,
 * at least 960px, the full width below that (Main › Navigation); `width` sets a fixed width
 * instead (the skill panel, 640px), still never wider than the window. Its scroll is
 * contained, so reaching its end does not scroll the page behind. role="dialog", aria-modal;
 * focus moves in on open, Tab stays inside, Esc (inside it, or anywhere on the page when no
 * overlay above it took the key) and the scrim emit close, and focus returns to the opener
 * when it closes or unmounts (or to returnFocusFallback when the opener is gone). The drawer does not close itself: it is route-backed,
 * so the page changes the route on `close`.
 *
 * Parts: #header (sticky, on --surface; put the element with `titleId` in it) · the default
 * slot (20px 24px 48px padding, 28px between sections). Extra attributes land on the aside.
 */
defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** Shown while true; the default suits a drawer mounted only while its route is active. */
    open?: boolean;
    /** id of the heading inside #header that names the drawer. */
    titleId?: string | null;
    /** Accessible name when there is no heading. */
    label?: string | null;
    /** Where focus starts: a selector inside the drawer. */
    initialFocus?: string;
    bodyClass?: string | null;
    /** A fixed width in px; null keeps 75% of the window, at least 960px. */
    width?: number | null;
    /** Where focus goes on close when the opener is gone (see useFocusTrap). */
    returnFocusFallback?: (() => HTMLElement | null) | null;
  }>(),
  {
    open: true,
    titleId: null,
    label: null,
    initialFocus: '[data-primary]',
    bodyClass: null,
    width: null,
    returnFocusFallback: null,
  },
);
const emit = defineEmits<{ close: [] }>();

const fallbackId = `drawer-${useId()}`;
const panel = ref<HTMLElement | null>(null);

const { onKeydown, focusStart } = useFocusTrap(panel, {
  active: () => props.open,
  onEscape: () => emit('close'),
  initialFocus: props.initialFocus,
  returnFocusFallback: () => props.returnFocusFallback?.() ?? null,
});

// Esc anywhere: an overlay above the drawer (a Dialog) stops the key before it gets here.
useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.open && !event.defaultPrevented) emit('close');
});

defineExpose({ focusStart, panel });
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-40 flex justify-end bg-scrim"
    data-testid="drawer-scrim"
    @mousedown.self="emit('close')"
  >
    <aside
      ref="panel"
      v-bind="$attrs"
      class="flex h-full flex-col overflow-y-auto overscroll-contain border-l border-border bg-bg shadow-float focus:outline-none"
      :class="width === null ? 'w-[min(100%,max(960px,75%))]' : 'w-full'"
      :style="width === null ? undefined : { maxWidth: `${width}px` }"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId ?? (label ? undefined : fallbackId)"
      :aria-label="titleId ? undefined : (label ?? undefined)"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header
        v-if="$slots.header"
        :id="titleId || label ? undefined : fallbackId"
        class="sticky top-0 z-3 flex flex-col gap-10 border-b border-border bg-surface px-24 pt-14 pb-12"
      >
        <slot name="header" />
      </header>
      <div :class="bodyClass ?? 'flex flex-col gap-28 px-24 pt-20 pb-48'">
        <slot />
      </div>
    </aside>
  </div>
</template>

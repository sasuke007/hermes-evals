<script setup lang="ts">
import { computed, ref, useId, useSlots } from 'vue';

/**
 * A tooltip on hover and on keyboard focus, never the only place information lives: a
 * disabled button's reason is also its aria-description (Main › Ids and copy; RunInspectorStates
 * › disabled A/B). Esc hides it while the pointer or focus stays (WCAG 1.4.13); with no
 * tooltip to hide (disabled, or nothing to say) Esc goes on to the drawer or dialog around.
 *
 *   inverse  short text on --text, 6px 10px (a disabled control's reason, a full id)
 *   card     a panel on --surface with a shadow, 10px 12px (a grid cell's run, an invalid
 *            task's reason); width defaults to 300px
 *
 * The trigger is the default slot; bind `describedBy` to the focusable element so screen
 * readers read the tooltip with it:
 *   <BaseTooltip text="Counterpart run was cancelled" v-slot="{ describedBy }">
 *     <button class="btn" disabled :aria-describedby="describedBy">…</button>
 *   </BaseTooltip>
 */
const props = withDefaults(
  defineProps<{
    /** The tooltip text; #content replaces it for rich content. */
    text?: string | null;
    variant?: 'inverse' | 'card';
    placement?: 'top' | 'bottom';
    /** card: width in px. */
    width?: number;
    /** false hides it (nothing to explain right now). */
    enabled?: boolean;
  }>(),
  { text: null, variant: 'inverse', placement: 'top', width: 300, enabled: true },
);

const id = `tooltip-${useId()}`;
const slots = useSlots();
const dismissed = ref(false);
/** There is a tooltip to show (and so for Esc to hide). */
const shown = computed(() => props.enabled && (!!props.text || !!slots.content));

const classes = computed(() => [
  props.placement === 'top' ? 'bottom-full mb-6' : 'top-full mt-6',
  props.variant === 'card'
    ? 'flex flex-col gap-4 rounded-6 border border-border bg-surface px-12 py-10 text-text shadow-float whitespace-normal'
    : 'rounded-4 bg-text px-10 py-6 text-12 text-bg whitespace-nowrap',
  dismissed.value ? 'hidden' : 'group-hover/tooltip:visible group-focus-within/tooltip:visible',
]);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && shown.value && !dismissed.value) {
    dismissed.value = true;
    event.stopPropagation();
  }
}
</script>

<template>
  <span
    class="group/tooltip relative inline-flex"
    @keydown="onKeydown"
    @mouseleave="dismissed = false"
    @focusout="dismissed = false"
  >
    <slot :described-by="enabled ? id : undefined" />
    <span
      v-if="shown"
      :id="id"
      role="tooltip"
      class="pointer-events-none invisible absolute left-1/2 z-10 -translate-x-1/2"
      :class="classes"
      :style="variant === 'card' ? { width: `${width}px` } : undefined"
    >
      <slot name="content">{{ text }}</slot>
    </span>
  </span>
</template>

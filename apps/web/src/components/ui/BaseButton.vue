<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';

/**
 * One primary button per view. A disabled button always says why: `disabledReason` disables
 * it and becomes its tooltip and aria-description. With `to` it renders a RouterLink, with
 * `href` an anchor (external ones open in a new tab); a disabled link renders as a button.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'ghost' | 'danger';
    /** sm 26px · mid 28px · md 32px (default) · lg 32px / 13px. */
    size?: 'sm' | 'mid' | 'md' | 'lg';
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    disabledReason?: string | null;
    to?: RouteLocationRaw | null;
    href?: string | null;
    /** For href: open in a new tab with rel="noopener". */
    external?: boolean;
  }>(),
  {
    variant: 'default',
    size: 'md',
    type: 'button',
    disabled: false,
    disabledReason: null,
    to: null,
    href: null,
    external: false,
  },
);

const isDisabled = computed(() => props.disabled || !!props.disabledReason);
const classes = computed(() => [
  'btn',
  props.variant === 'default' ? '' : props.variant,
  props.size === 'md' ? '' : props.size,
]);
</script>

<template>
  <RouterLink v-if="to && !isDisabled" :to="to" :class="classes"><slot /></RouterLink>
  <a
    v-else-if="href && !isDisabled"
    :href="href"
    :class="classes"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener noreferrer' : undefined"
    ><slot
  /></a>
  <button
    v-else
    :type="type"
    :class="classes"
    :disabled="isDisabled"
    :title="disabledReason ?? undefined"
    :aria-description="disabledReason ?? undefined"
  >
    <slot />
  </button>
</template>

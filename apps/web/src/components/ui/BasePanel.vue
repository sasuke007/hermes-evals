<script setup lang="ts">
import { computed, useId } from 'vue';
import PanelHeader from './PanelHeader.vue';

/**
 * A group on a page: a 1px --border box with a 6px radius on --surface, no shadow
 * (Main › Density: panels, not cards). With `title` it draws its PanelHeader and is labelled
 * by it; #header replaces that header, #actions fills its right side. `padding` pads the body
 * (none for a table or list that runs edge to edge).
 */
const props = withDefaults(
  defineProps<{
    title?: string | null;
    /** Caption on the right of the header. */
    meta?: string | null;
    as?: 'section' | 'div' | 'article' | 'aside';
    padding?: 'none' | 'sm' | 'md' | 'lg';
    /** strong: a --border-strong edge, for a card that asks for action (SetupCard). */
    border?: 'default' | 'strong' | 'dashed';
    /** Clip children to the rounded corners (tables, bars). */
    clip?: boolean;
  }>(),
  {
    title: null,
    meta: null,
    as: 'section',
    padding: 'none',
    border: 'default',
    clip: false,
  },
);

const headingId = `panel-${useId()}`;
const PADDING = { none: '', sm: 'px-16 py-12', md: 'p-16', lg: 'p-20' } as const;
const BORDER = {
  default: 'border-border',
  strong: 'border-border-strong',
  dashed: 'border-dashed border-border-strong',
} as const;
const bodyClass = computed(() => PADDING[props.padding]);
</script>

<template>
  <component
    :is="as"
    class="rounded-6 border bg-surface"
    :class="[BORDER[border], { 'overflow-hidden': clip }]"
    :aria-labelledby="title ? headingId : undefined"
  >
    <slot name="header">
      <PanelHeader v-if="title" :id="headingId" :title="title" :meta="meta">
        <template v-if="$slots.actions" #actions><slot name="actions" /></template>
      </PanelHeader>
    </slot>
    <div v-if="bodyClass" :class="bodyClass"><slot /></div>
    <slot v-else />
  </component>
</template>

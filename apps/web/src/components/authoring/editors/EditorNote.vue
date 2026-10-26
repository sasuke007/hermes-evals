<script setup lang="ts">
import NoteIcon from './NoteIcon.vue';

/**
 * A note in the task editor (SA.4 to SA.6, `.te-note`): `problem` violet on a dotted edge,
 * `warning` amber, `info` neutral. The bold lead goes in #lead (or `lead`), the rest in the
 * default slot; #actions sits on the right, centred.
 */
withDefaults(
  defineProps<{
    tone: 'problem' | 'warning' | 'info';
    lead?: string | null;
    /** role=alert for a problem the user just caused; status otherwise. */
    alert?: boolean;
    centered?: boolean;
  }>(),
  { lead: null, alert: false, centered: false },
);

const BOX = {
  problem: 'border border-dotted border-err bg-err-soft',
  warning: 'border border-ung bg-ung-soft',
  info: 'border border-border bg-surface-2',
} as const;
const LEAD = { problem: 'text-err-text', warning: 'text-ung-text', info: 'text-text' } as const;
</script>

<template>
  <div
    :role="alert ? 'alert' : 'status'"
    class="flex gap-8 rounded-4 px-10 py-8 text-12 leading-18"
    :class="[BOX[tone], centered ? 'items-center' : 'items-start']"
    :data-tone="tone"
  >
    <NoteIcon :kind="tone" />
    <span class="min-w-0 flex-1"
      ><b v-if="lead || $slots.lead" :class="LEAD[tone]"
        ><slot name="lead">{{ lead }}</slot></b
      >{{ lead || $slots.lead ? ' ' : '' }}<slot
    /></span>
    <slot name="actions" />
  </div>
</template>

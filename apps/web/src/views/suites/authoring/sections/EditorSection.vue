<script setup lang="ts">
import ZoneLabel from '@/components/suites/ZoneLabel.vue';

/**
 * One section of the task editor's Form tab (SA.4): "② Prompt" with its zone label and
 * caption, then its body. Platform metadata (Task, Limits) has no zone label and a
 * description line; what the agent sees is a plain panel; what it never sees is the
 * hatched, dashed "Hidden from the agent" panel.
 */
withDefaults(
  defineProps<{
    id: string;
    /** "② Prompt". */
    title: string;
    zone?: 'visible' | 'hidden' | null;
    caption?: string | null;
    description?: string | null;
  }>(),
  { zone: null, caption: null, description: null },
);
</script>

<template>
  <section
    :id="`s-${id}`"
    :aria-labelledby="`h-${id}`"
    class="scroll-mt-16 rounded-6"
    :class="
      zone === 'hidden'
        ? 'border border-dashed border-border-strong bg-[repeating-linear-gradient(135deg,var(--surface)_0_10px,var(--surface-2)_10px_20px)]'
        : 'border border-border bg-surface'
    "
    :data-section="id"
  >
    <div
      class="flex flex-wrap items-center gap-x-10 gap-y-6 px-16 py-12"
      :class="
        zone === 'hidden' ? 'border-b border-dashed border-border-strong' : 'border-b border-border'
      "
    >
      <h2 :id="`h-${id}`" class="m-0 text-15 font-semibold">{{ title }}</h2>
      <ZoneLabel v-if="zone" :zone="zone" />
      <span v-if="caption" class="text-12 text-text-3"
        ><slot name="caption">{{ caption }}</slot></span
      >
      <span v-if="description" class="basis-full text-13 text-text-2">{{ description }}</span>
    </div>
    <div class="flex flex-col gap-12 px-16 pt-14 pb-16">
      <slot />
    </div>
  </section>
</template>

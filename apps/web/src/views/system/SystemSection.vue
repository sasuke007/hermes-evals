<script setup lang="ts">
/**
 * One section of the System page, as the board draws it: an h2 (15/22) with a caption on the
 * right of the same line, then the section's alert and table 8px below. The section is labelled
 * by its heading.
 */
defineProps<{
  /** The heading's id; the section is labelled by it. */
  id: string;
  title: string;
  caption?: string | null;
}>();
</script>

<template>
  <section :aria-labelledby="id" class="flex flex-col gap-8" :data-section="id">
    <div class="flex flex-wrap items-baseline justify-between gap-12">
      <h2 :id="id" class="text-15 font-semibold">{{ title }}</h2>
      <span v-if="caption" class="text-12 text-text-3">{{ caption }}</span>
    </div>
    <slot />
  </section>
</template>

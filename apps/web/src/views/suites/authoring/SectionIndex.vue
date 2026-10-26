<script setup lang="ts">
/**
 * The Form tab's section index (SA.4): a link per section, with a violet dotted dot beside a
 * section that has a problem and an amber one beside a section with a warning.
 */
defineProps<{
  sections: Array<{ id: string; label: string; mark: 'problem' | 'warning' | null }>;
}>();
const emit = defineEmits<{ go: [id: string] }>();
</script>

<template>
  <nav
    aria-label="Sections"
    class="flex flex-wrap gap-x-14 gap-y-4 py-2"
    data-testid="section-index"
  >
    <a
      v-for="s in sections"
      :key="s.id"
      :href="`#s-${s.id}`"
      class="inline-flex items-center gap-5 text-12 text-text-2 hover:text-accent"
      :data-mark="s.mark ?? undefined"
      @click.prevent="emit('go', s.id)"
      >{{ s.label
      }}<span
        v-if="s.mark"
        class="size-7 rounded-full"
        :class="
          s.mark === 'warning' ? 'bg-ung' : 'border-[1.5px] border-dotted border-err bg-err-soft'
        "
        :aria-label="s.mark === 'warning' ? 'Has a warning' : 'Has a problem'"
        role="img"
    /></a>
  </nav>
</template>

<script setup lang="ts">
/**
 * One reason an upload cannot be stored: a cross, the title in bold and what to do in
 * --text-2. `boxed` draws it as its own alert (orange fill and border); otherwise it is one
 * row of the bordered problem list.
 */
withDefaults(defineProps<{ title: string; detail?: string | null; boxed?: boolean }>(), {
  detail: null,
  boxed: false,
});
</script>

<template>
  <div
    class="grid grid-cols-[18px_minmax(0,1fr)] gap-8 px-12"
    :class="boxed ? 'rounded-4 border border-fail bg-fail-soft py-10' : 'py-8'"
    :role="boxed ? 'alert' : undefined"
    data-testid="upload-problem"
  >
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="mt-3 text-fail">
      <path
        d="M3.5 3.5l7 7M10.5 3.5l-7 7"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
    <span
      ><b :class="boxed ? 'text-fail-text' : undefined">{{ title }}</b
      >{{ detail ? ' ' : '' }}<span v-if="detail" class="text-text-2">{{ detail }}</span></span
    >
  </div>
</template>

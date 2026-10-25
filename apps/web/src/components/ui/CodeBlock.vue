<script setup lang="ts">
import CopyButton from './CopyButton.vue';

/**
 * A block of monospace text kept as written: YAML, config.yaml, stderr tails, verifier
 * source, a command's output. 12/18 mono on --surface-2 (`plain` on --surface, as on
 * SuiteDetail), wrapping long lines. `copy` adds a copy button at the top right.
 */
withDefaults(
  defineProps<{
    code: string;
    /** sm: 8px 10px padding (Secrets) · md: 10px 12px. */
    size?: 'sm' | 'md';
    plain?: boolean;
    copy?: boolean;
    copyLabel?: string;
    /** Max height in px before it scrolls. */
    maxHeight?: number | null;
    /** Accessible name: "config.yaml". */
    label?: string | null;
  }>(),
  {
    size: 'md',
    plain: false,
    copy: false,
    copyLabel: 'Copy',
    maxHeight: null,
    label: null,
  },
);
</script>

<template>
  <div class="relative">
    <pre
      class="overflow-auto rounded-4 border border-border font-mono text-12 leading-18 break-words whitespace-pre-wrap"
      :class="[
        plain ? 'bg-surface' : 'bg-surface-2',
        size === 'sm' ? 'px-10 py-8' : 'px-12 py-10',
        { 'pr-36': copy },
      ]"
      :style="maxHeight ? { maxHeight: `${maxHeight}px` } : undefined"
      :aria-label="label ?? undefined"
      data-testid="code-block"
      >{{ code }}</pre>
    <div v-if="copy" class="absolute top-4 right-4">
      <CopyButton :text="code" :label="copyLabel" />
    </div>
  </div>
</template>

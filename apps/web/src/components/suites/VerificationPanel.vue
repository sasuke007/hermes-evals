<script setup lang="ts">
import type { VerificationEntryView } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import { plural } from '@/lib/format';
import VerificationSentence from './VerificationSentence.vue';
import ZoneLabel from './ZoneLabel.vue';

/**
 * A task's checks, in the order they are scored (TaskDetail board): each entry's key, its
 * tags (primary first, then the type), its sentence and its raw YAML, which starts open on
 * the primary check.
 */
defineProps<{ verification: VerificationEntryView[] }>();
</script>

<template>
  <BasePanel aria-labelledby="task-verification" clip>
    <template #header>
      <div class="flex items-center justify-between gap-10 border-b border-border px-16 py-12">
        <span class="flex flex-wrap items-center gap-10">
          <h2 id="task-verification" class="text-15 font-semibold">Verification</h2>
          <ZoneLabel zone="hidden" />
        </span>
        <span class="text-12 text-text-3"
          >{{ plural(verification.length, 'check') }} · scored in this order</span
        >
      </div>
    </template>
    <div class="flex flex-col gap-2 border-b border-border px-16 py-10 text-12 text-text-3">
      <span>Each check is scored on its own. There is no combined total.</span>
      <span
        >The <b>primary</b> check is the run's result in experiments. The others are extra scores
        you can switch to on the Comparison tab.</span
      >
    </div>
    <div class="flex flex-col">
      <div
        v-for="entry in verification"
        :key="entry.key"
        class="flex flex-col gap-8 border-b border-border px-16 py-14 last:border-b-0"
        :data-check="entry.key"
      >
        <div class="flex flex-wrap items-center gap-10">
          <span class="font-mono font-semibold">{{ entry.key }}</span>
          <BaseTag v-if="entry.primary">primary</BaseTag>
          <BaseTag>{{ entry.type }}</BaseTag>
        </div>
        <VerificationSentence :entry="entry" />
        <details :open="entry.primary">
          <summary>Raw YAML</summary>
          <pre
            class="mt-6 rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
            >{{ entry.yaml }}</pre>
        </details>
      </div>
    </div>
  </BasePanel>
</template>

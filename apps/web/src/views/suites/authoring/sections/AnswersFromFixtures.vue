<script setup lang="ts">
import { computed } from 'vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import { useDraftTaskStore } from '@/stores/draftTask';

/**
 * Under the workspace files (Phase 5b question 1): "The answer is picked from these files"
 * sets `self_check.answers_from_fixtures`, which turns off the reference-leak warning for a
 * task whose answer is, by design, a value its own data holds (an invoice number from
 * invoices.csv). Shown while the warning is up or the setting is on, so other tasks keep a
 * quiet section.
 */
const task = useDraftTaskStore();
const on = computed(() => task.form?.answersFromFixtures === true);
const warned = computed(
  () => task.detail?.readiness.issues.some((i) => i.rule === 'reference_leak') ?? false,
);
</script>

<template>
  <label
    v-if="task.form && (on || warned)"
    class="flex cursor-pointer items-start gap-10 rounded-4 border border-border bg-surface px-12 py-10"
    data-testid="answers-from-fixtures"
  >
    <BaseToggle
      :model-value="on"
      aria-label="The answer is picked from these files"
      :disabled="task.locked"
      @update:model-value="task.editForm((f) => (f.answersFromFixtures = $event ? true : null))"
    />
    <span
      ><b>The answer is picked from these files</b>{{ ' '
      }}<span class="text-text-2"
        >Its values are in the workspace files by design, such as invoice numbers from
        <code>invoices.csv</code>, so a reference value found there is not a leak. Stored as
        <code>self_check.answers_from_fixtures</code>.</span
      ></span
    >
  </label>
</template>

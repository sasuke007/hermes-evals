<script setup lang="ts">
import { computed } from 'vue';
import { useDraftTaskStore } from '@/stores/draftTask';
import EditorSection from './EditorSection.vue';
import FieldMessage from './FieldMessage.vue';
import { issueAt } from './fieldIssues';

/**
 * ⑧ Limits (SA.4): guidance shown on New experiment; runs use the configuration's limits
 * (plan 7). Max turns 1 to 200, run budget 30 to 3600 seconds, and the toolsets the task
 * needs, as chips with the common ones to add. An out-of-range value is stored and said
 * ("Max turns is 1 to 200."), never refused.
 */
const task = useDraftTaskStore();
const SUGGESTED = ['file', 'terminal', 'web', 'browser', 'code_execution'];

const issues = computed(() => task.detail?.readiness.issues ?? []);
const turnsIssue = computed(() => issueAt(issues.value, 'maxTurns'));
const budgetIssue = computed(() => issueAt(issues.value, 'runBudgetSeconds'));
const toolsets = computed(() => task.form?.toolsetsNeeded ?? []);
const addable = computed(() => SUGGESTED.filter((t) => !toolsets.value.includes(t)));

function number(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() === '' || !Number.isFinite(n) ? null : Math.trunc(n);
}
</script>

<template>
  <EditorSection
    id="limits"
    title="⑧ Limits"
    description="Guidance shown on New experiment. Runs use the configuration's limits."
  >
    <div class="grid grid-cols-[160px_200px_minmax(0,1fr)] items-start gap-16 max-lg:grid-cols-2">
      <div class="flex flex-col gap-4">
        <label for="te-turns" class="text-12 font-medium text-text-2">Max turns</label>
        <input
          id="te-turns"
          class="input w-full font-mono text-12"
          :class="turnsIssue ? 'border-err shadow-[inset_0_0_0_1px_var(--err)]' : ''"
          inputmode="numeric"
          :value="task.form?.maxTurns ?? ''"
          :readonly="task.locked"
          :aria-invalid="turnsIssue ? 'true' : undefined"
          data-field="maxTurns"
          @input="
            task.editForm((f) => (f.maxTurns = number(($event.target as HTMLInputElement).value)))
          "
        />
        <FieldMessage v-if="turnsIssue" v-bind="turnsIssue" />
        <span v-else class="text-12 text-text-3">1 to 200</span>
      </div>
      <div class="flex flex-col gap-4">
        <label for="te-bud" class="text-12 font-medium text-text-2">Run budget</label>
        <span class="flex items-center gap-6">
          <input
            id="te-bud"
            class="input w-full font-mono text-12"
            :class="budgetIssue ? 'border-err shadow-[inset_0_0_0_1px_var(--err)]' : ''"
            inputmode="numeric"
            :value="task.form?.runBudgetSeconds ?? ''"
            :readonly="task.locked"
            :aria-invalid="budgetIssue ? 'true' : undefined"
            data-field="runBudgetSeconds"
            @input="
              task.editForm(
                (f) => (f.runBudgetSeconds = number(($event.target as HTMLInputElement).value)),
              )
            "
          /><span class="text-text-2">s</span>
        </span>
        <FieldMessage v-if="budgetIssue" v-bind="budgetIssue" />
        <span v-else class="text-12 text-text-3">30 to 3600</span>
      </div>
      <div class="flex min-w-0 flex-col gap-4">
        <span class="text-12 font-medium text-text-2">Toolsets needed</span>
        <span class="flex flex-wrap items-center gap-6" data-field="toolsetsNeeded">
          <span
            v-for="t in toolsets"
            :key="t"
            class="inline-flex h-24 items-center gap-4 rounded-3 border border-border bg-surface-2 pr-4 pl-8 font-mono text-12"
            >{{ t
            }}<button
              type="button"
              class="inline-flex size-18 items-center justify-center rounded-4 text-text-2 hover:bg-surface-3"
              :aria-label="`Remove ${t}`"
              :disabled="task.locked"
              @click="
                task.editForm((f) => (f.toolsetsNeeded = f.toolsetsNeeded.filter((x) => x !== t)))
              "
            >
              ×
            </button></span
          >
          <span v-if="addable.length" class="text-12 text-text-3">Add:</span>
          <button
            v-for="t in addable"
            :key="t"
            type="button"
            class="btn ghost h-24"
            :disabled="task.locked"
            @click="task.editForm((f) => f.toolsetsNeeded.push(t))"
          >
            + {{ t }}
          </button>
        </span>
      </div>
    </div>
  </EditorSection>
</template>

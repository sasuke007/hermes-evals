<script setup lang="ts">
import { computed } from 'vue';
import EditorNote from '@/components/authoring/editors/EditorNote.vue';
import CodeText from '@/components/authoring/editors/CodeText.vue';
import { useDraftTaskStore } from '@/stores/draftTask';
import EditorSection from './EditorSection.vue';
import FieldMessage from './FieldMessage.vue';
import { issueAt } from './fieldIssues';

/**
 * ① Task (SA.4, SA.5): the key, which is also the folder name, and the summary shown in
 * lists and results. Neither is sent to the agent. A key that is not a folder name, or that
 * another task holds, is said at once and not stored; renaming a task the base holds makes
 * it a new task, and the editor says what that means for results.
 */
const task = useDraftTaskStore();

const issues = computed(() => task.detail?.readiness.issues ?? []);
const summaryIssue = computed(() => issueAt(issues.value, 'summary'));
const keyIssue = computed(() =>
  task.keyProblem
    ? { message: task.keyProblem, severity: 'problem' as const }
    : issueAt(issues.value, 'key'),
);
const renamedFrom = computed(() => {
  const base = task.detail?.base;
  return base && task.keyDraft !== base.key && !task.keyProblem ? base.key : null;
});
</script>

<template>
  <EditorSection
    id="task"
    title="① Task"
    description="The key and summary identify the task in lists and results. They are not sent to the agent."
  >
    <div class="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-16 max-lg:grid-cols-1">
      <div class="flex min-w-0 flex-col gap-4">
        <label for="te-key" class="text-12 font-medium text-text-2">Key</label>
        <input
          id="te-key"
          class="input w-full font-mono text-12"
          :class="
            keyIssue
              ? 'border-err shadow-[inset_0_0_0_1px_var(--err)]'
              : renamedFrom
                ? 'border-ung'
                : ''
          "
          :value="task.keyDraft"
          :readonly="task.locked"
          :aria-invalid="keyIssue ? 'true' : undefined"
          :aria-describedby="keyIssue ? 'te-key-msg' : 'te-key-help'"
          spellcheck="false"
          data-field="key"
          @input="task.editKey(($event.target as HTMLInputElement).value)"
        />
        <FieldMessage v-if="keyIssue" id="te-key-msg" v-bind="keyIssue" />
        <span v-else id="te-key-help" class="text-12 text-text-3"
          ><CodeText text="Letters, digits, `.`, `_` and `-`. Also the folder name."
        /></span>
      </div>
      <div class="flex min-w-0 flex-col gap-4">
        <label for="te-sum" class="text-12 font-medium text-text-2">Summary</label>
        <input
          id="te-sum"
          class="input w-full"
          :class="summaryIssue ? 'border-err shadow-[inset_0_0_0_1px_var(--err)]' : ''"
          :value="task.form?.summary ?? ''"
          :readonly="task.locked"
          :aria-invalid="summaryIssue ? 'true' : undefined"
          data-field="summary"
          @input="task.editForm((f) => (f.summary = ($event.target as HTMLInputElement).value))"
        />
        <FieldMessage v-if="summaryIssue" v-bind="summaryIssue" />
        <span v-else class="text-12 text-text-3">Shown in task lists and experiment results.</span>
      </div>
    </div>
    <EditorNote
      v-if="renamedFrom"
      tone="warning"
      lead="Renaming makes this a new task."
      data-testid="rename-note"
    >
      <span class="text-text-2"
        >Results recorded under <code>{{ renamedFrom }}</code> won't compare with results under the
        new key.</span
      >
    </EditorNote>
  </EditorSection>
</template>

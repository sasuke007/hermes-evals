<script setup lang="ts">
import { computed } from 'vue';
import CodeText from '@/components/authoring/editors/CodeText.vue';
import EditorNote from '@/components/authoring/editors/EditorNote.vue';
import JsonEditor from '@/components/authoring/editors/JsonEditor.vue';
import NoteIcon from '@/components/authoring/editors/NoteIcon.vue';
import { jsonProblem } from '@/components/authoring/editors/editorText';
import { useDraftTaskStore } from '@/stores/draftTask';
import EditorSection from './EditorSection.vue';

/**
 * ⑤ Reference answer (SA.4, SA.5): reference.json as typed, never copied into a run; only the
 * checks read it. Invalid JSON is stored and reported. Under it, the value each answer check
 * reads, or why it reads none ("`answer` reads `overdue` → no value.").
 */
const task = useDraftTaskStore();
const values = computed(() => task.detail?.readiness.referenceValues ?? []);
const empty = computed(() => task.reference.trim() === '');
const invalid = computed(() => !empty.value && jsonProblem(task.reference) !== null);
const answerChecks = computed(() => values.value.length > 0);
/** With no answer check, what each other check reads instead (TaskEditor board, summary_file). */
const otherReads = computed(() => {
  const clauses = (task.form?.checks ?? []).flatMap((check): string[] => {
    const key = `\`${check.key}\``;
    switch (check.type) {
      case 'file_check':
        return [`${key} reads the workspace`];
      case 'verifier_script':
        return [`${key} (verifier script) gets the answer and the workspace`];
      case 'trajectory_match':
      case 'llm_judge':
        return [`${key} is checked when runs are scored`];
      default:
        return [];
    }
  });
  return clauses.length > 0 ? ` ${clauses.join('; ')}.` : '';
});
</script>

<template>
  <EditorSection
    id="reference"
    title="⑤ Reference answer"
    zone="hidden"
    caption="Never copied into a run. Only the checks read it."
  >
    <JsonEditor
      id="te-reference"
      :model-value="task.reference"
      label="Reference answer"
      :readonly="task.locked"
      data-field="reference"
      @update:model-value="task.editReference"
    />
    <div
      class="flex flex-col gap-6 rounded-4 border border-border bg-surface px-12 py-10"
      data-testid="reference-values"
    >
      <span class="text-12 font-medium text-text-2">Values the checks read</span>
      <span v-if="empty" class="text-12 text-text-3"
        >Enter the reference to see the values the checks read.</span
      >
      <span v-else-if="invalid" class="text-12 text-text-3"
        >Values can be read once the reference is valid JSON.</span
      >
      <span v-else-if="!answerChecks" class="text-12 text-text-3"
        ><CodeText :text="`No answer check reads the reference.${otherReads}`"
      /></span>
      <template v-for="v in invalid || empty ? [] : values" :key="v.key">
        <span v-if="v.found" class="flex items-center gap-6 text-12"
          ><NoteIcon kind="ok" /><span
            ><code>{{ v.key }}</code> reads <code>{{ v.path ?? 'the whole answer' }}</code> →
            <span class="font-mono font-semibold">{{ v.preview }}</span></span
          ></span
        >
        <EditorNote v-else tone="problem">
          <template #lead
            ><CodeText :text="`\`${v.key}\` reads \`${v.path ?? ''}\` → no value.`"
          /></template>
          <span class="text-text-2"
            ><CodeText
              :text="`The reference has no value at \`${v.path ?? ''}\`, so this check would end as error.`"
          /></span>
        </EditorNote>
      </template>
    </div>
  </EditorSection>
</template>

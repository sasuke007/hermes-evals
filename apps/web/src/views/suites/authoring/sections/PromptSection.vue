<script setup lang="ts">
import { computed, ref } from 'vue';
import { answerInstructions, appendParagraph, type JsonValue } from '@hermes-evals/shared';
import EditorNote from '@/components/authoring/editors/EditorNote.vue';
import MarkdownEditor from '@/components/authoring/editors/MarkdownEditor.vue';
import NoteIcon from '@/components/authoring/editors/NoteIcon.vue';
import { useDraftTaskStore } from '@/stores/draftTask';
import EditorSection from './EditorSection.vue';
import FieldMessage from './FieldMessage.vue';
import { issueAt } from './fieldIssues';

/**
 * ② Prompt (SA.4, SA.5): prompt.md exactly as the agent receives it (as task.txt in its
 * home), saved as typed. Under it, the files the prompt mentions and where the task has
 * them, and, when the prompt does not ask for the fenced json block answer checks read,
 * the paragraph Add answer instructions appends (the shape gives no value away).
 */
const task = useDraftTaskStore();
const editor = ref<InstanceType<typeof MarkdownEditor> | null>(null);

const readiness = computed(() => task.detail?.readiness ?? null);
const issue = computed(() => issueAt(readiness.value?.issues ?? [], 'prompt'));
const noBlock = computed(
  () => readiness.value?.rules.find((r) => r.rule === 'answer_block')?.status === 'warning',
);
const reference = computed<JsonValue | undefined>(() => {
  try {
    return JSON.parse(task.reference) as JsonValue;
  } catch {
    return undefined;
  }
});
const paragraph = computed(() =>
  answerInstructions(task.form?.answerPath ?? null, reference.value),
);
const WHERE = {
  workspace: 'in workspace files',
  expected: 'in the expected workspace (written by the agent)',
  home: 'in home files',
} as const;

function addInstructions(): void {
  task.editPrompt(appendParagraph(task.prompt, paragraph.value));
}

defineExpose({ focus: () => editor.value?.focus() });
</script>

<template>
  <EditorSection
    id="prompt"
    title="② Prompt"
    zone="visible"
    caption="Sent as task.txt in the agent's home"
  >
    <template #caption>Sent as <code>task.txt</code> in the agent's home</template>
    <MarkdownEditor
      id="te-prompt"
      ref="editor"
      :model-value="task.prompt"
      label="Prompt"
      :readonly="task.locked"
      :invalid="issue?.severity === 'problem'"
      data-field="prompt"
      @update:model-value="task.editPrompt"
    />
    <FieldMessage v-if="issue" v-bind="issue" />
    <div
      v-if="readiness?.mentionedFiles.length"
      class="flex flex-wrap items-center gap-x-14 gap-y-6 text-12"
      data-testid="mentioned-files"
    >
      <span class="font-medium text-text-2">Files mentioned</span>
      <template v-for="m in readiness.mentionedFiles" :key="m.name">
        <span v-if="m.location !== 'missing'" class="inline-flex items-center gap-4"
          ><code>{{ m.name }}</code
          ><NoteIcon kind="ok" /><span class="text-text-2">{{ WHERE[m.location] }}</span></span
        >
        <span v-else class="inline-flex items-center gap-4 text-ung-text" data-missing
          ><NoteIcon kind="warning" /><code>{{ m.name }}</code
          >: not in workspace files</span
        >
      </template>
    </div>
    <EditorNote v-if="noBlock" tone="warning" data-testid="no-answer-block">
      <template #lead>The prompt doesn't ask for a fenced json block.</template>
      <span class="text-text-2">Without one, answer checks are ungradable.</span>
      <span class="mt-6 block text-12 text-text-3">Appends:</span>
      <pre
        class="mt-6 rounded-4 border border-border bg-surface px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
        >{{ paragraph }}</pre>
      <template #actions>
        <button type="button" class="btn" :disabled="task.locked" @click="addInstructions">
          Add answer instructions
        </button>
      </template>
    </EditorNote>
  </EditorSection>
</template>

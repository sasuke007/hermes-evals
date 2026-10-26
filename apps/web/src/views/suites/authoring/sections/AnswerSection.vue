<script setup lang="ts">
import { computed } from 'vue';
import CodeText from '@/components/authoring/editors/CodeText.vue';
import { useDraftTaskStore } from '@/stores/draftTask';
import EditorSection from './EditorSection.vue';
import FieldMessage from './FieldMessage.vue';
import { issueAt } from './fieldIssues';

/**
 * ④ Answer (SA.4): how the agent's answer is read, the last fenced JSON block of its final
 * reply, and the path inside it the primary check reads (empty compares the whole block).
 */
const task = useDraftTaskStore();
const issue = computed(() => issueAt(task.detail?.readiness.issues ?? [], 'answerPath'));
const placeholder = computed(() => task.detail?.key ?? 'total_due');
</script>

<template>
  <EditorSection
    id="answer"
    title="④ Answer"
    zone="hidden"
    caption="How the agent's answer is read from its final reply"
  >
    <div class="grid grid-cols-2 items-start gap-16 max-lg:grid-cols-1">
      <div class="flex flex-col gap-4">
        <span class="text-12 font-medium text-text-2">Format</span>
        <span
          ><span class="chip h-24 bg-que-soft text-que-text"
            >Fenced JSON block · the last one in the agent's final reply</span
          ></span
        >
      </div>
      <div class="flex min-w-0 flex-col gap-4">
        <label for="te-path" class="text-12 font-medium text-text-2"
          >Answer path <span class="font-normal text-text-3">optional</span></label
        >
        <input
          id="te-path"
          class="input w-full font-mono text-12"
          :class="
            issue?.severity === 'problem' ? 'border-err shadow-[inset_0_0_0_1px_var(--err)]' : ''
          "
          :value="task.form?.answerPath ?? ''"
          :placeholder="placeholder"
          :readonly="task.locked"
          spellcheck="false"
          data-field="answerPath"
          @input="
            task.editForm((f) => (f.answerPath = ($event.target as HTMLInputElement).value || null))
          "
        />
        <FieldMessage v-if="issue" v-bind="issue" />
        <span class="text-12 text-text-3"
          ><CodeText
            text="The value inside the block that the primary check reads, e.g. `total_due` or `totals.vat`. Leave empty to compare the whole block."
        /></span>
      </div>
    </div>
  </EditorSection>
</template>

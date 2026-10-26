<script setup lang="ts">
import { computed } from 'vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import { useDraftTaskStore } from '@/stores/draftTask';
import EditorSection from './EditorSection.vue';
import FilesPart from './FilesPart.vue';

/**
 * ⑦ Expected workspace (SA.4, SA.6): the files a correct agent leaves, laid over the
 * workspace files to check the checks, never placed in a run; and with it the negative
 * control, on by default, which checks that the untouched workspace fails. A memory task's
 * expected home (Phase 6) is drawn here too, under the same rules; the boards draw only
 * the workspace.
 */
const task = useDraftTaskStore();
const form = computed(() => task.form);
const negative = computed(() => form.value?.negativeControl !== false);
</script>

<template>
  <EditorSection
    id="expected"
    :title="form?.expectedWorkspace ? '⑦ Expected workspace' : '⑦ Expected home'"
    zone="hidden"
    caption="The files a correct agent leaves behind. Used only to check your checks. Never placed in a run."
  >
    <template v-if="form?.expectedWorkspace">
      <FilesPart kind="expected" />
      <span class="text-12 text-text-3"
        >Laid over the workspace files: a file with the same path replaces the original. Stored as
        <code>{{ form.expectedWorkspace }}/</code>.</span
      >
    </template>
    <template v-if="form?.expectedHome">
      <span v-if="form.expectedWorkspace" class="text-13 font-semibold">Expected home</span>
      <FilesPart kind="expected_home" />
      <span class="text-12 text-text-3"
        >Laid over the home files: the memory files a correct agent leaves. Stored as
        <code>{{ form.expectedHome }}/</code>.</span
      >
    </template>
    <label
      class="flex cursor-pointer items-start gap-10 rounded-4 border border-border bg-surface px-12 py-10"
    >
      <BaseToggle
        :model-value="negative"
        aria-label="Negative control"
        :disabled="task.locked"
        @update:model-value="task.editForm((f) => (f.negativeControl = $event ? null : false))"
      />
      <span
        ><b>Negative control</b>{{ ' '
        }}<span class="text-text-2"
          >Also check that the untouched workspace fails. This proves the check isn't passing on the
          starting files.</span
        ></span
      >
    </label>
  </EditorSection>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseDialog from '@/components/ui/BaseDialog.vue';

/**
 * "Add task › Duplicate a task…" on Suite detail: pick the task to copy. The copy is added
 * to the suite's draft under a free key (`total_due_copy`) and opens in the editor, where it
 * can be renamed. No board draws this step; the wording is ours.
 */
const props = defineProps<{ keys: string[] }>();
const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ duplicate: [key: string] }>();

const picked = ref('');
watch(open, (isOpen) => {
  if (isOpen) picked.value = props.keys[0] ?? '';
});

function confirm(): void {
  if (!picked.value) return;
  open.value = false;
  emit('duplicate', picked.value);
}
</script>

<template>
  <BaseDialog
    v-model:open="open"
    title="Duplicate a task"
    :width="480"
    body-class="flex flex-col gap-8 p-16"
    initial-focus="#duplicate-task-key"
    data-testid="duplicate-task-dialog"
  >
    <label class="text-12 font-medium text-text-2" for="duplicate-task-key">Task to copy</label>
    <select id="duplicate-task-key" v-model="picked" class="input font-mono text-12">
      <option v-for="key in keys" :key="key" :value="key">{{ key }}</option>
    </select>
    <span class="text-12 text-text-3"
      >The copy is added to the draft as <code>{{ picked }}_copy</code> and opens in the editor,
      where you can rename it. Nothing on disk changes until you save.</span
    >
    <template #footer>
      <button type="button" class="btn" @click="open = false">Cancel</button>
      <button type="button" class="btn primary" :disabled="!picked" @click="confirm">
        Duplicate
      </button>
    </template>
  </BaseDialog>
</template>

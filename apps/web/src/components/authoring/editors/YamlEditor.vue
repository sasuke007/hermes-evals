<script setup lang="ts">
import { computed, ref } from 'vue';
import CodeTextArea from './CodeTextArea.vue';
import CodeText from './CodeText.vue';
import EditorNote from './EditorNote.vue';
import { yamlSuggestion } from './editorText';

/**
 * task.yaml exactly as it is written (Components 5, YamlEditor; SA.6): the file's path and
 * state over a line-numbered area, the error the API located ("line 9, col 7: unknown key
 * `prmary`. Did you mean `primary`?") underlined in place with "Change to primary" when
 * there is a suggestion, and the sentence on what this file is. The API keeps comments and
 * key order (plan 4.6, V5).
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** `overdue_count/task.yaml`. */
    path: string;
    /** The API's located error (DraftTaskDetail.formLock), or null. */
    error?: { line: number | null; column: number | null; message: string } | null;
    /** Further lines to mark (a second `primary: true`). */
    markedLines?: number[];
    readonly?: boolean;
  }>(),
  { error: null, markedLines: () => [], readonly: false },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const focused = ref(false);
const area = ref<InstanceType<typeof CodeTextArea> | null>(null);
const hint = computed(() => (props.error ? yamlSuggestion(props.error.message) : null));
const status = computed(() => (props.error ? '1 error' : 'valid · written as shown'));
const where = computed(() => {
  const e = props.error;
  if (!e?.line) return '';
  return e.column ? `line ${e.line}, col ${e.column}: ` : `line ${e.line}: `;
});
/** The message's first sentence in bold, the rest ("Did you mean …?") after it. */
const parts = computed(() => {
  const message = props.error?.message ?? '';
  const cut = message.indexOf('. ');
  return cut < 0
    ? { lead: message, rest: '' }
    : { lead: message.slice(0, cut + 1), rest: message.slice(cut + 2) };
});

/** Change to the suggestion: the bad token is replaced where it stands. */
function applySuggestion(): void {
  const e = props.error;
  const h = hint.value;
  if (!e?.line || !h?.token || !h.suggestion) return;
  const lines = props.modelValue.split('\n');
  const line = lines[e.line - 1];
  if (line === undefined) return;
  const start = e.column ? e.column - 1 : line.indexOf(h.token);
  if (start < 0 || line.slice(start, start + h.token.length) !== h.token) return;
  lines[e.line - 1] = `${line.slice(0, start)}${h.suggestion}${line.slice(start + h.token.length)}`;
  emit('update:modelValue', lines.join('\n'));
}

defineExpose({
  focus: () => area.value?.focus(),
  focusAt: (line: number, column?: number) => area.value?.focusAt(line, column),
});
</script>

<template>
  <div class="flex w-full flex-col gap-8">
    <div
      class="overflow-hidden rounded-4 border bg-surface"
      :class="
        focused && !readonly
          ? 'border-focus shadow-[0_0_0_1px_var(--focus)]'
          : 'border-border-strong'
      "
      data-testid="yaml-editor"
    >
      <div
        class="flex items-center justify-between gap-8 border-b border-border bg-surface-2 px-10 py-5 font-sans"
      >
        <span class="font-mono text-12 font-semibold">{{ path }}</span>
        <span class="text-12 text-text-3" data-testid="yaml-status">{{ status }}</span>
      </div>
      <CodeTextArea
        ref="area"
        :model-value="modelValue"
        label="task.yaml"
        :readonly="readonly"
        :error-line="error?.line ?? null"
        :error-column="error?.column ?? null"
        :error-length="hint?.token?.length ?? null"
        :marked-lines="markedLines"
        :invalid="!!error"
        @update:model-value="emit('update:modelValue', $event)"
        @focus="focused = true"
        @blur="focused = false"
      />
    </div>
    <EditorNote v-if="error" tone="problem" alert centered data-testid="yaml-error">
      <template #lead>{{ where }}<CodeText :text="parts.lead" /></template>
      <CodeText v-if="parts.rest" :text="parts.rest" />
      <template v-if="hint?.suggestion && hint.token" #actions>
        <button type="button" class="btn mid" @click="applySuggestion">
          Change to <span class="font-mono">{{ hint.suggestion }}</span>
        </button>
      </template>
    </EditorNote>
    <p class="m-0 text-12 text-text-3">
      This is the file on disk. Edits here and in the form are the same file. Your comments and key
      order are kept.
    </p>
  </div>
</template>

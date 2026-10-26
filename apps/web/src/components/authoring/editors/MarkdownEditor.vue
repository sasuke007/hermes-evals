<script setup lang="ts">
import { computed, ref } from 'vue';
import CodeTextArea from './CodeTextArea.vue';
import CodeText from './CodeText.vue';
import { markdownBlocks } from './editorText';

/**
 * prompt.md (visible) and a rubric (hidden), as typed (Components 5, MarkdownEditor): an
 * Edit · Preview control and the character count over a line-numbered mono area. The text
 * is saved exactly as typed (plan 4.6). Read-only while task.yaml has an error ("Read-only
 * until `task.yaml` is fixed.").
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    readonly?: boolean;
    /** The read-only note under it; the default is the task.yaml one. */
    readonlyNote?: string | null;
    placeholder?: string;
    invalid?: boolean;
    describedBy?: string | null;
    id?: string | null;
  }>(),
  {
    readonly: false,
    readonlyNote: 'Read-only until `task.yaml` is fixed.',
    placeholder: 'Write exactly what the agent receives.',
    invalid: false,
    describedBy: null,
    id: null,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const mode = ref<'edit' | 'preview'>('edit');
const focused = ref(false);
const area = ref<InstanceType<typeof CodeTextArea> | null>(null);
const count = computed(() => `${props.modelValue.length.toLocaleString('en-US')} characters`);
const blocks = computed(() => markdownBlocks(props.modelValue));

defineExpose({
  focus: () => {
    mode.value = 'edit';
    area.value?.focus();
  },
});
</script>

<template>
  <div class="flex w-full flex-col gap-6">
    <div
      class="overflow-hidden rounded-4 border font-mono text-12 leading-20"
      :class="[
        focused && !readonly
          ? 'border-focus shadow-[0_0_0_1px_var(--focus)]'
          : 'border-border-strong',
        readonly ? 'bg-surface-2' : 'bg-surface',
        invalid ? 'border-err' : '',
      ]"
      data-testid="markdown-editor"
    >
      <div
        class="flex items-center justify-between gap-8 border-b border-border bg-surface-2 px-8 py-5 font-sans"
      >
        <div
          class="inline-flex overflow-hidden rounded-4 border border-border-strong"
          role="group"
          aria-label="Editor mode"
        >
          <button
            v-for="m in ['edit', 'preview'] as const"
            :key="m"
            type="button"
            class="h-24 px-10 text-12 font-medium"
            :class="mode === m ? 'bg-surface-3 text-text' : 'bg-surface text-text-2'"
            :aria-pressed="mode === m"
            @click="mode = m"
          >
            {{ m === 'edit' ? 'Edit' : 'Preview' }}
          </button>
        </div>
        <span class="text-12 text-text-3" data-testid="char-count">{{ count }}</span>
      </div>
      <CodeTextArea
        v-if="mode === 'edit'"
        :id="id"
        ref="area"
        :model-value="modelValue"
        :label="label"
        :readonly="readonly"
        :placeholder="placeholder"
        :min-height="modelValue === '' ? 132 : 0"
        :invalid="invalid"
        :described-by="describedBy"
        @update:model-value="emit('update:modelValue', $event)"
        @focus="focused = true"
        @blur="focused = false"
      />
      <div
        v-else
        class="flex flex-col gap-10 px-16 py-12 font-sans text-13 leading-20"
        data-testid="markdown-preview"
      >
        <template v-for="(b, i) in blocks" :key="i">
          <p v-if="b.kind === 'p'" class="m-0">
            <template v-for="(s, j) in b.segments" :key="j"
              ><code v-if="s.code">{{ s.text }}</code
              ><span v-else>{{ s.text }}</span></template
            >
          </p>
          <b v-else-if="b.kind === 'h'" class="text-15">{{ b.text }}</b>
          <div v-else-if="b.kind === 'li'" class="flex gap-8">
            <span class="text-text-3">•</span><span>{{ b.text }}</span>
          </div>
          <pre
            v-else
            class="m-0 rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
            >{{ b.text }}</pre>
        </template>
      </div>
    </div>
    <span v-if="readonly && readonlyNote" class="text-12 text-text-3"
      ><CodeText :text="readonlyNote"
    /></span>
  </div>
</template>

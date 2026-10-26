<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * The text area under MarkdownEditor, JsonEditor and YamlEditor (Components 5): mono 12/20,
 * a 40px line-number gutter and a 10px marker column, an error line on --err-soft with a
 * dotted marker and the bad token underlined in wavy violet. The numbers follow the lines
 * of the text, wrapped ones included: the visible text is a mirror of the value, and a
 * transparent textarea with the same metrics lies over its text column, so typing, the
 * caret and selection are the browser's own and no editor library is needed. Tab moves
 * focus on, as in any form field.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Accessible name of the textarea. */
    label: string;
    readonly?: boolean;
    placeholder?: string | null;
    /** A 1-based line to mark as an error, with the column and length of the bad token. */
    errorLine?: number | null;
    errorColumn?: number | null;
    errorLength?: number | null;
    /** Further lines on --err-soft without a token (two `primary: true` lines). */
    markedLines?: number[];
    /** Lines of empty space the area keeps at least (an empty prompt is 1 line + 100px). */
    minHeight?: number;
    /** Id of the text that describes the area (an error under it). */
    describedBy?: string | null;
    id?: string | null;
    invalid?: boolean;
  }>(),
  {
    readonly: false,
    placeholder: null,
    errorLine: null,
    errorColumn: null,
    errorLength: null,
    markedLines: () => [],
    minHeight: 0,
    describedBy: null,
    id: null,
    invalid: false,
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: string]; focus: []; blur: [] }>();

const area = ref<HTMLTextAreaElement | null>(null);

interface Line {
  n: number;
  before: string;
  bad: string;
  after: string;
  marked: boolean;
  gutter: boolean;
}

const lines = computed<Line[]>(() =>
  props.modelValue.split('\n').map((text, i) => {
    const n = i + 1;
    const isError = n === props.errorLine;
    if (isError && props.errorColumn) {
      const start = Math.min(text.length, props.errorColumn - 1);
      const rest = text.slice(start);
      const length = props.errorLength ?? (/^[^\s:,{}[\]]+/.exec(rest)?.[0].length || 1);
      return {
        n,
        before: text.slice(0, start),
        bad: rest.slice(0, length),
        after: rest.slice(length),
        marked: true,
        gutter: true,
      };
    }
    const marked = isError || props.markedLines.includes(n);
    return { n, before: text, bad: '', after: '', marked, gutter: marked };
  }),
);

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}

defineExpose({
  focus: () => area.value?.focus(),
  /** Puts the caret at a 1-based line and column (a Fix link, an error's location). */
  focusAt(line: number, column = 1): void {
    const el = area.value;
    if (!el) return;
    const offsets = props.modelValue.split('\n').slice(0, line - 1);
    const at = offsets.reduce((sum, l) => sum + l.length + 1, 0) + column - 1;
    el.focus();
    el.setSelectionRange(at, at);
  },
});
</script>

<template>
  <div class="relative py-6 font-mono text-12 leading-20" :style="{ minHeight: `${minHeight}px` }">
    <div
      v-for="line in lines"
      :key="line.n"
      class="grid grid-cols-[40px_10px_minmax(0,1fr)]"
      :class="line.marked ? 'bg-err-soft' : ''"
      :data-line="line.n"
      :data-marked="line.marked || undefined"
    >
      <span class="pr-6 text-right text-text-3 select-none" aria-hidden="true">{{ line.n }}</span>
      <span class="flex items-center justify-center">
        <span
          v-if="line.gutter"
          class="size-8 rounded-full border-[1.5px] border-dotted border-err bg-err-soft"
          aria-label="Error on this line"
          role="img"
        />
      </span>
      <span class="pr-12 break-words whitespace-pre-wrap" aria-hidden="true"
        >{{ line.before
        }}<span
          v-if="line.bad"
          class="bg-err-soft underline decoration-err decoration-wavy underline-offset-3 [text-decoration-skip-ink:none]"
          data-testid="squiggle"
          >{{ line.bad }}</span
        >{{ line.after }}&#8203;</span
      >
    </div>
    <textarea
      :id="id ?? undefined"
      ref="area"
      :value="modelValue"
      :readonly="readonly"
      :placeholder="placeholder ?? undefined"
      :aria-label="label"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedBy ?? undefined"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      class="absolute inset-y-6 right-0 left-50 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 pr-12 font-mono text-12 leading-20 break-words whitespace-pre-wrap text-transparent caret-text outline-none placeholder:text-text-3"
      @input="onInput"
      @focus="emit('focus')"
      @blur="emit('blur')"
    />
  </div>
</template>

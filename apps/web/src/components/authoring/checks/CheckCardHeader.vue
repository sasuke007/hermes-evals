<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { ScoreStatus } from '@hermes-evals/shared';
import type { TaskFormCheck } from '@/api/types/authoring';
import CodeText from '../editors/CodeText.vue';
import { CHECK_TYPE_NAMES, checkSentence, effectivePath, isAnswerCheck } from './checkText';

/**
 * The row of a CheckCard (SA.7): drag handle, key, type, the Primary radio, the check in
 * plain words, its last result, and Expand with Delete (collapsed) or the ⋯ menu (expanded:
 * Change type…, Duplicate check, Delete). Delete asks first, inline ("Delete check
 * `answer`?"). The handle moves the card with the arrow keys as well as by dragging.
 */
const props = withDefaults(
  defineProps<{
    check: TaskFormCheck;
    answerPath: string | null;
    expanded: boolean;
    bodyId: string;
    readonly?: boolean;
    invalid?: boolean;
    referenceMissing?: boolean;
    referenceStatus?: ScoreStatus | null;
    expectedStatus?: string | null;
    primaryNote?: string | null;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
  }>(),
  {
    readonly: false,
    invalid: false,
    referenceMissing: false,
    referenceStatus: null,
    expectedStatus: null,
    primaryNote: null,
    canMoveUp: false,
    canMoveDown: false,
  },
);
const emit = defineEmits<{
  toggle: [];
  makePrimary: [];
  delete: [];
  duplicate: [];
  changeType: [];
  move: [step: -1 | 1];
}>();

const menuOpen = ref(false);
const confirming = ref(false);
const keepButton = ref<HTMLButtonElement | null>(null);

const sentence = computed(() => checkSentence(props.check, props.answerPath));

/** The result chip: settings, the reference, the expected workspace, or when it is checked. */
const result = computed(() => {
  const type = props.check.type;
  if (props.invalid)
    return {
      label: 'settings invalid',
      chip: 'bg-err-soft text-err-text',
      dot: 'border-[1.5px] border-dotted border-err size-8',
    };
  if (props.referenceMissing) {
    const path = effectivePath(props.check, props.answerPath) ?? '';
    return {
      label: `no value at ${path} in the reference`,
      chip: 'bg-err-soft text-err-text',
      dot: 'border-[1.5px] border-err size-7',
    };
  }
  if (isAnswerCheck(type)) {
    const s = props.referenceStatus;
    if (s === 'passed')
      return {
        label: 'passes on the reference',
        chip: 'bg-pass-soft text-pass-text',
        dot: 'bg-pass size-6',
      };
    if (s === 'failed')
      return {
        label: 'fails on the reference',
        chip: 'bg-fail-soft text-fail-text',
        dot: 'bg-fail size-6',
      };
    if (s)
      return {
        label: `${s} on the reference`,
        chip: 'bg-err-soft text-err-text',
        dot: 'bg-err size-6',
      };
    return {
      label: 'not tried yet',
      chip: 'bg-que-soft text-que-text',
      dot: 'border-[1.5px] border-que size-7',
    };
  }
  if (type === 'file_check') {
    if (props.expectedStatus === 'passed')
      return {
        label: 'passes on the expected workspace',
        chip: 'bg-pass-soft text-pass-text',
        dot: 'bg-pass size-6',
      };
    if (props.expectedStatus)
      return {
        label: 'fails on the expected workspace',
        chip: 'bg-fail-soft text-fail-text',
        dot: 'bg-fail size-6',
      };
    return {
      label: 'not checked yet',
      chip: 'bg-que-soft text-que-text',
      dot: 'border-[1.5px] border-que size-7',
    };
  }
  if (type === 'verifier_script')
    return {
      label: 'runs in the self-check',
      chip: 'bg-que-soft text-que-text',
      dot: 'border-[1.5px] border-que size-7',
    };
  return {
    label: 'checked when runs are scored',
    chip: 'bg-que-soft text-que-text',
    dot: 'border-[1.5px] border-que size-7',
  };
});

async function askDelete(): Promise<void> {
  menuOpen.value = false;
  confirming.value = true;
  await nextTick();
  keepButton.value?.focus();
}

function confirmDelete(): void {
  confirming.value = false;
  emit('delete');
}

function pick(action: 'changeType' | 'duplicate'): void {
  menuOpen.value = false;
  if (action === 'changeType') emit('changeType');
  else emit('duplicate');
}

function onHandleKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowUp' && props.canMoveUp) emit('move', -1);
  else if (event.key === 'ArrowDown' && props.canMoveDown) emit('move', 1);
  else return;
  event.preventDefault();
}
</script>

<template>
  <div
    class="grid min-h-44 grid-cols-[16px_minmax(90px,auto)_auto_auto_minmax(0,1fr)_auto_auto] items-center gap-10 py-6 pr-8 pl-10 max-lg:grid-cols-[16px_auto_auto_auto_minmax(0,1fr)_auto]"
  >
    <button
      type="button"
      class="inline-flex cursor-grab border-0 bg-transparent p-0 text-text-3"
      aria-label="Drag to reorder"
      title="Drag to reorder"
      data-drag-handle
      :disabled="readonly"
      @keydown="onHandleKey"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="9" cy="6" r="1.6" />
        <circle cx="15" cy="6" r="1.6" />
        <circle cx="9" cy="12" r="1.6" />
        <circle cx="15" cy="12" r="1.6" />
        <circle cx="9" cy="18" r="1.6" />
        <circle cx="15" cy="18" r="1.6" />
      </svg>
    </button>
    <code class="text-13 font-semibold" data-testid="check-key">{{ check.key }}</code>
    <span class="tag font-sans text-12" :title="check.type">{{
      CHECK_TYPE_NAMES[check.type]
    }}</span>
    <button
      type="button"
      role="radio"
      :aria-checked="check.primary ? 'true' : 'false'"
      class="inline-flex items-center gap-6 border-0 bg-transparent p-0 text-12 whitespace-nowrap"
      :class="check.primary ? 'font-medium text-text' : 'text-text-2'"
      :disabled="readonly"
      @click="emit('makePrimary')"
    >
      <i
        class="size-14 flex-none rounded-full bg-surface"
        :class="check.primary ? 'border-4 border-accent' : 'border-[1.5px] border-border-strong'"
        aria-hidden="true"
      />Primary
    </button>
    <span class="min-w-0 truncate text-12 text-text-2 max-lg:hidden" data-testid="check-sentence"
      ><span class="font-mono">{{ check.type }}</span> <CodeText :text="sentence"
    /></span>
    <span class="chip" :class="result.chip" data-testid="check-result"
      ><span class="flex-none rounded-full" :class="result.dot" aria-hidden="true" />{{
        result.label
      }}</span
    >
    <span class="relative inline-flex gap-2">
      <button
        type="button"
        class="inline-flex size-26 items-center justify-center rounded-4 border-0 bg-transparent text-text-3 hover:bg-surface-2 hover:text-text"
        :aria-label="expanded ? 'Collapse' : 'Expand'"
        :title="expanded ? 'Collapse' : 'Expand'"
        :aria-expanded="expanded"
        :aria-controls="bodyId"
        @click="emit('toggle')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 12 12"
          aria-hidden="true"
          :class="expanded ? 'rotate-90' : ''"
        >
          <path
            d="M4 2.5 7.5 6 4 9.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        v-if="!expanded"
        type="button"
        class="inline-flex size-26 items-center justify-center rounded-4 border-0 bg-transparent text-text-3 hover:bg-surface-2 hover:text-text"
        :aria-label="`Delete check ${check.key}`"
        title="Delete check"
        :disabled="readonly"
        @click="askDelete"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
        </svg>
      </button>
      <button
        v-else
        type="button"
        class="inline-flex size-26 items-center justify-center rounded-4 border-0 bg-transparent text-text-3 hover:bg-surface-2 hover:text-text"
        :class="menuOpen ? 'bg-surface-2 text-text' : ''"
        :aria-label="`More actions for ${check.key}`"
        title="More actions"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        :disabled="readonly"
        @click="menuOpen = !menuOpen"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      <div
        v-if="menuOpen"
        role="menu"
        aria-label="Check actions"
        class="absolute top-30 right-0 z-5 flex w-200 flex-col rounded-6 border border-border bg-surface p-4 shadow-float"
        @keydown.esc="menuOpen = false"
      >
        <button
          type="button"
          role="menuitem"
          class="rounded-4 px-10 py-6 text-left hover:bg-surface-2"
          @click="pick('changeType')"
        >
          Change type…
        </button>
        <button
          type="button"
          role="menuitem"
          class="rounded-4 px-10 py-6 text-left hover:bg-surface-2"
          @click="pick('duplicate')"
        >
          Duplicate check
        </button>
        <div class="my-4 h-1 bg-border" />
        <button
          type="button"
          role="menuitem"
          class="rounded-4 px-10 py-6 text-left text-fail-text hover:bg-surface-2"
          @click="askDelete"
        >
          Delete
        </button>
      </div>
    </span>
  </div>
  <div
    v-if="primaryNote"
    class="flex items-start gap-6 pr-12 pb-8 pl-36 text-12 leading-18 text-text-2"
    role="status"
    data-testid="primary-note"
  >
    <CodeText :text="primaryNote" />
  </div>
  <div
    v-if="confirming"
    role="alertdialog"
    aria-label="Delete check"
    class="flex flex-wrap items-center gap-x-12 gap-y-8 border-t border-fail bg-fail-soft px-12 py-8"
    @keydown.esc="confirming = false"
  >
    <b class="text-fail-text"
      >Delete check <code>{{ check.key }}</code
      >?</b
    >
    <span class="text-12 text-text-2">{{
      check.primary
        ? 'It is the primary check: the next check becomes primary.'
        : 'Its settings are removed from the draft.'
    }}</span>
    <span class="flex-1" />
    <button
      type="button"
      class="btn sm border-fail bg-fail text-bg hover:bg-fail hover:text-bg"
      @click="confirmDelete"
    >
      Delete
    </button>
    <button ref="keepButton" type="button" class="btn sm" @click="confirming = false">Keep</button>
  </div>
</template>

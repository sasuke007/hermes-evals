<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { JsonValue, ScorerType } from '@hermes-evals/shared';
import type {
  DraftSelfCheckView,
  ReadinessIssue,
  ReferenceValue,
  TaskFormCheck,
} from '@/api/types/authoring';
import type { TryState } from '@/stores/draftTaskTools';
import CheckCard from './CheckCard.vue';
import CheckPicker from './CheckPicker.vue';
import {
  changeType,
  defaultCheckKey,
  defaultParams,
  effectivePath,
  suggestion,
  valueAtPath,
} from './checkText';

/**
 * The body of the task editor's ⑥ Checks section (SA.4, SA.7a): how checks combine, the
 * cards in scoring order, + Add check with the picker as a popover under it, and the empty
 * state. Exactly one check is primary: the first one added is, and deleting the primary
 * makes the next one primary, each said on the card. A card arrives expanded with focus in
 * Path (or Key) and an accent outline that fades. Cards reorder by their handle (drag, or
 * the arrow keys). Every change goes out as the whole list (`update`).
 */
const props = withDefaults(
  defineProps<{
    checks: TaskFormCheck[];
    answerPath: string | null;
    /** The parsed reference, or undefined while it is missing or not JSON. */
    reference: JsonValue | undefined;
    referenceValues: ReferenceValue[];
    issues: ReadinessIssue[];
    tries: Record<string, TryState>;
    selfCheck: DraftSelfCheckView | null;
    selfCheckRunning?: boolean;
    expectedFolder: string | null;
    scripts: Array<{ path: string; sizeBytes: number; sha256: string }>;
    sources: Record<string, { text: string | null; error: string | null }>;
    rubrics: Record<string, string>;
    readonly?: boolean;
  }>(),
  { selfCheckRunning: false, readonly: false },
);
const emit = defineEmits<{
  update: [checks: TaskFormCheck[]];
  reply: [key: string, text: string];
  runSelfCheck: [];
  rubric: [path: string, text: string];
  loadSource: [path: string];
}>();

const expanded = ref<Record<string, boolean>>({});
const notes = ref<Record<string, string>>({});
const changed = ref<
  Record<string, { from: ScorerType; dropped: string[]; previous: TaskFormCheck }>
>({});
const fresh = ref<string | null>(null);
/** The picker: adding, or changing the type of the check at `index`. */
const picker = ref<{ mode: 'add' } | { mode: 'replace'; index: number } | null>(null);
const addButton = ref<HTMLButtonElement | null>(null);
const dragging = ref<number | null>(null);

const scriptNames = computed(() => props.scripts.map((s) => s.path.replace(/^verify\//i, '')));
const suggested = computed(() => {
  const path = props.answerPath;
  return suggestion(valueAtPath(props.reference, path), path);
});

function errorsFor(index: number): { errors: Record<string, string>; keyError: string | null } {
  const errors: Record<string, string> = {};
  let keyError: string | null = null;
  for (const issue of props.issues) {
    const field = issue.target.field ?? '';
    if (field === `checks.${index}.key`) keyError ??= issue.message;
    const param = new RegExp(`^checks\\.${index}\\.params\\.?(.*)$`).exec(field);
    if (param) errors[param[1]?.split('.')[0] || 'params'] ??= issue.message;
  }
  return { errors, keyError };
}

function selfCheckFor(key: string) {
  return props.selfCheck?.results.filter((r) => r.key === key) ?? [];
}

function emitWith(next: TaskFormCheck[]): void {
  emit('update', next);
}

async function add(type: ScorerType, script?: string): Promise<void> {
  picker.value = null;
  const key = defaultCheckKey(
    type,
    props.checks.map((c) => c.key),
  );
  const first = props.checks.length === 0;
  const check: TaskFormCheck = {
    key,
    type,
    primary: first,
    params: defaultParams(type, script ?? null),
  };
  if (first)
    notes.value[key] = 'Primary: the first check is primary. Change it here when you add more.';
  fresh.value = key;
  expanded.value[key] = true;
  emitWith([...props.checks, check]);
  setTimeout(() => {
    if (fresh.value === key) fresh.value = null;
  }, 1500);
}

function replaceType(index: number, type: ScorerType, script?: string): void {
  picker.value = null;
  const current = props.checks[index]!;
  const result = changeType(current, type, script ?? null);
  changed.value[current.key] = { from: current.type, dropped: result.dropped, previous: current };
  emitWith(props.checks.map((c, i) => (i === index ? result.check : c)));
}

function undoChange(index: number): void {
  const key = props.checks[index]!.key;
  const entry = changed.value[key];
  if (!entry) return;
  delete changed.value[key];
  emitWith(props.checks.map((c, i) => (i === index ? entry.previous : c)));
}

function update(index: number, check: TaskFormCheck): void {
  const before = props.checks[index]!;
  if (before.key !== check.key) {
    // The card keeps its open state, its note and its Undo under the new key.
    for (const map of [expanded.value, notes.value, changed.value] as Array<
      Record<string, unknown>
    >) {
      if (!(before.key in map)) continue;
      map[check.key] = map[before.key];
      delete map[before.key];
    }
  }
  emitWith(props.checks.map((c, i) => (i === index ? check : c)));
}

function makePrimary(index: number): void {
  notes.value = {};
  emitWith(props.checks.map((c, i) => ({ ...c, primary: i === index })));
}

function remove(index: number): void {
  const removed = props.checks[index]!;
  const rest = props.checks.filter((_, i) => i !== index);
  if (removed.primary && rest[0]) {
    rest[0] = { ...rest[0], primary: true };
    notes.value = { [rest[0].key]: `\`${rest[0].key}\` is now primary.` };
  }
  emitWith(rest);
}

function duplicate(index: number): void {
  const from = props.checks[index]!;
  const key = defaultCheckKey(
    from.type,
    props.checks.map((c) => c.key),
  ).replace(/^(answer|file|tool_use|judge|script)/, from.key);
  const copy: TaskFormCheck = {
    ...structuredClone(from),
    key: props.checks.some((c) => c.key === key) ? `${from.key}_copy` : key,
    primary: false,
  };
  const next = [...props.checks];
  next.splice(index + 1, 0, copy);
  expanded.value[copy.key] = true;
  emitWith(next);
}

function move(from: number, to: number): void {
  if (to < 0 || to >= props.checks.length || from === to) return;
  const next = [...props.checks];
  const [card] = next.splice(from, 1);
  next.splice(to, 0, card!);
  emitWith(next);
}

async function closePicker(): Promise<void> {
  const was = picker.value;
  picker.value = null;
  await nextTick();
  if (was?.mode === 'add') addButton.value?.focus();
}

/** Opens the card at `index` (a Fix link aimed at one of its fields). */
async function reveal(index: number): Promise<void> {
  const check = props.checks[index];
  if (!check) return;
  expanded.value[check.key] = true;
  await nextTick();
}

defineExpose({ reveal });

function onDragStart(index: number, event: DragEvent): void {
  if (
    !(event.target as HTMLElement).closest('[data-drag-handle]') &&
    !(event.target as HTMLElement).hasAttribute('draggable')
  )
    return;
  dragging.value = index;
  event.dataTransfer?.setData('text/plain', String(index));
}

function onDrop(index: number): void {
  if (dragging.value !== null) move(dragging.value, index);
  dragging.value = null;
}
</script>

<template>
  <div class="flex flex-col gap-12">
    <div class="flex flex-col gap-2 text-12 leading-18 text-text-2">
      <span>Each check is scored on its own. There is no combined total.</span>
      <span
        >The <b>primary</b> check is the run's result in experiments. The others are extra scores
        you can switch to on the Comparison tab.</span
      >
    </div>
    <div
      v-if="checks.length === 0"
      class="flex flex-col gap-4 rounded-6 border border-dashed border-border-strong bg-surface px-16 py-18"
      data-testid="no-checks"
    >
      <b>No checks yet</b>
      <span class="text-text-2">Add at least one check. The first one becomes primary.</span>
    </div>
    <div
      v-for="(check, index) in checks"
      :key="check.key + ':' + index"
      :draggable="!readonly"
      :class="dragging === index ? 'opacity-60' : ''"
      @dragstart="onDragStart(index, $event)"
      @dragover.prevent
      @drop.prevent="onDrop(index)"
      @dragend="dragging = null"
    >
      <CheckCard
        v-model:expanded="expanded[check.key]"
        :check="check"
        :answer-path="answerPath"
        :readonly="readonly"
        :errors="errorsFor(index).errors"
        :key-error="errorsFor(index).keyError"
        :reference-value="valueAtPath(reference, effectivePath(check, answerPath))"
        :reference-missing="
          reference !== undefined &&
          referenceValues.find((v) => v.key === check.key)?.found === false
        "
        :try-state="tries[check.key] ?? null"
        :self-check-results="selfCheckFor(check.key)"
        :self-check-seconds="selfCheck ? Number((selfCheck.durationMs / 1000).toFixed(1)) : null"
        :self-check-stale="!!selfCheck && !selfCheck.current"
        :self-check-running="selfCheckRunning"
        :expected-folder="expectedFolder"
        :scripts="scripts"
        :script-source="sources[`verify/${String(check.params.script ?? '')}`]?.text ?? null"
        :script-source-error="sources[`verify/${String(check.params.script ?? '')}`]?.error ?? null"
        :rubric="rubrics[String(check.params.rubric ?? 'rubric.md')] ?? ''"
        :primary-note="notes[check.key] ?? null"
        :changed-from="
          changed[check.key]
            ? { from: changed[check.key]!.from, dropped: changed[check.key]!.dropped }
            : null
        "
        :fresh="fresh === check.key"
        :can-move-up="index > 0"
        :can-move-down="index < checks.length - 1"
        @update="update(index, $event)"
        @make-primary="makePrimary(index)"
        @delete="remove(index)"
        @duplicate="duplicate(index)"
        @change-type="picker = { mode: 'replace', index }"
        @undo-change="undoChange(index)"
        @reply="emit('reply', check.key, $event)"
        @run-self-check="emit('runSelfCheck')"
        @rubric="emit('rubric', String(check.params.rubric ?? 'rubric.md'), $event)"
        @load-source="emit('loadSource', $event)"
        @move="move(index, index + $event)"
      />
      <div v-if="picker?.mode === 'replace' && picker.index === index" class="relative z-20 mt-6">
        <CheckPicker
          mode="replace"
          :check-key="check.key"
          :current-type="check.type"
          :suggested="suggested"
          :no-reference="reference === undefined"
          :scripts="scriptNames"
          @pick="(type, script) => replaceType(index, type, script)"
          @close="closePicker"
        />
      </div>
    </div>
    <span v-if="checks.length > 1" class="text-12 text-text-3"
      >Scored in this order. Drag a card by its handle to change it.</span
    >
    <div class="relative self-start">
      <button
        ref="addButton"
        type="button"
        class="btn"
        :class="picker?.mode === 'add' ? 'bg-surface-2' : ''"
        aria-haspopup="listbox"
        :aria-expanded="picker?.mode === 'add'"
        :disabled="readonly"
        data-testid="add-check"
        @click="picker = picker?.mode === 'add' ? null : { mode: 'add' }"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.25"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" /></svg
        >Add check
      </button>
      <div v-if="picker?.mode === 'add'" class="absolute top-38 left-0 z-20">
        <CheckPicker
          :suggested="suggested"
          :no-reference="reference === undefined"
          :scripts="scriptNames"
          @pick="add"
          @close="closePicker"
        />
      </div>
    </div>
  </div>
</template>

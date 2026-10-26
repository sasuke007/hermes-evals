<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import type { ScorerType } from '@hermes-evals/shared';
import CodeText from '../editors/CodeText.vue';
import { CHECK_TYPE_NAMES, PICKER_GROUPS, type PickerCard } from './checkText';
import { CHOOSE_SCRIPT_FIRST, initialScript, scriptOptions } from './scriptChoice';

/**
 * The gallery + Add check opens (Components 5, CheckPicker; SA.7, SA.7a): a 560px popover
 * under the button, grouped Answer, Workspace, Behaviour, Judge and Script. Each card says
 * what it checks, what to use it for and whether it gives partial credit; the reference
 * suggests one. Verifier script is disabled until the task has a file in verify/; then its
 * card asks for the script first (Phase 5b question 19): a Script field in the card, set to
 * the task's only Python file or else empty, and picking the card without one says so and
 * focuses the field. In replace mode (Change type…) the current type is marked and
 * disabled. The cards are a listbox: arrow keys move, Enter picks, Esc closes and focus
 * returns to what opened it.
 */
const props = withDefaults(
  defineProps<{
    mode?: 'add' | 'replace';
    /** The key whose type changes, in replace mode ("Change `answer` to…"). */
    checkKey?: string | null;
    currentType?: ScorerType | null;
    suggested?: { type: ScorerType; reason: string } | null;
    /** No reference yet: the header asks for one. */
    noReference?: boolean;
    /** The task's files under verify/, by name there: `check_summary.py`. */
    scripts?: string[];
  }>(),
  {
    mode: 'add',
    checkKey: null,
    currentType: null,
    suggested: null,
    noReference: false,
    scripts: () => [],
  },
);
/** `script` comes with verifier_script only: the file the card asked for. */
const emit = defineEmits<{ pick: [type: ScorerType, script?: string]; close: [] }>();

const list = ref<HTMLElement | null>(null);
const optionId = (type: ScorerType) => `ck-opt-${type}`;
const hasScripts = computed(() => props.scripts.length > 0);
const disabled = (type: ScorerType) =>
  (props.mode === 'replace' && type === props.currentType) ||
  (type === 'verifier_script' && !hasScripts.value);
const order = computed(() =>
  PICKER_GROUPS.flatMap((g) => g.cards.map((c) => c.type)).filter((t) => !disabled(t)),
);
const active = ref<ScorerType | null>(null);

onMounted(async () => {
  active.value =
    props.suggested && !disabled(props.suggested.type)
      ? props.suggested.type
      : (order.value[0] ?? null);
  await nextTick();
  list.value?.focus();
});

/** The Verifier script card's Script field, and whether a pick without one asked for it. */
const scriptId = useId();
/** The field sits in the cards' v-for, so it is kept by a function ref, not a ref array. */
let scriptField: HTMLSelectElement | null = null;
const keepScriptField = (el: unknown): void => {
  scriptField = el instanceof HTMLSelectElement ? el : null;
};
const script = ref<string | null>(initialScript(props.scripts));
const askingScript = ref(false);
const scriptChoices = computed(() => scriptOptions(props.scripts));

function pick(type: ScorerType): void {
  if (type !== 'verifier_script') {
    emit('pick', type);
    return;
  }
  if (script.value) {
    emit('pick', type, script.value);
    return;
  }
  active.value = type;
  askingScript.value = true;
  scriptField?.focus();
}

function onScriptChange(): void {
  askingScript.value = false;
  active.value = 'verifier_script';
}

/** In the Script field the arrow keys are the select's; Enter adds, Esc still closes. */
function onScriptKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') return;
  event.stopPropagation();
  if (event.key !== 'Enter') return;
  event.preventDefault();
  pick('verifier_script');
}

function onKeydown(event: KeyboardEvent): void {
  const i = active.value ? order.value.indexOf(active.value) : -1;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
    active.value = order.value[Math.min(order.value.length - 1, i + 1)] ?? null;
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
    active.value = order.value[Math.max(0, i - 1)] ?? null;
  else if (event.key === 'Home') active.value = order.value[0] ?? null;
  else if (event.key === 'End') active.value = order.value[order.value.length - 1] ?? null;
  else if (event.key === 'Enter' || event.key === ' ') {
    if (active.value) pick(active.value);
  } else if (event.key === 'Escape') emit('close');
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function choose(card: PickerCard): void {
  if (!disabled(card.type)) pick(card.type);
}

/** The groups as the board lays them out: Behaviour and Judge side by side, the others alone. */
const SIDE_BY_SIDE = new Set(['behaviour', 'judge']);
const rows = PICKER_GROUPS.reduce<(typeof PICKER_GROUPS)[number][][]>((out, group) => {
  const last = out[out.length - 1];
  if (SIDE_BY_SIDE.has(group.id) && last && SIDE_BY_SIDE.has(last[0]!.id)) last.push(group);
  else out.push([group]);
  return out;
}, []);

const title = computed(() =>
  props.mode === 'replace' ? `Change \`${props.checkKey ?? 'check'}\` to…` : 'Add a check',
);
</script>

<template>
  <div
    role="dialog"
    aria-labelledby="pk-t"
    aria-describedby="pk-d"
    class="flex w-560 max-w-[calc(100vw-32px)] flex-col rounded-8 border border-border bg-surface shadow-float"
    data-testid="check-picker"
    @keydown.esc.stop="emit('close')"
  >
    <div class="flex items-start justify-between gap-12 border-b border-border px-16 py-12">
      <div class="flex flex-col gap-2">
        <h2 id="pk-t" class="m-0 text-15 font-semibold"><CodeText :text="title" /></h2>
        <span id="pk-d" class="text-12 text-text-3"
          >Checks score the agent's answer. They are hidden from the agent. Each check is scored on
          its own; one is primary.</span
        >
        <span v-if="noReference" class="text-12 text-text-2"
          >Add the reference answer to get a suggestion.</span
        >
        <span v-if="mode === 'replace'" class="text-12 text-text-2"
          >The key and Primary stay. Settings that don't apply to the new type are dropped, and you
          can undo.</span
        >
      </div>
      <button
        type="button"
        class="inline-flex size-26 flex-none items-center justify-center rounded-4 border-0 bg-transparent text-text-3 hover:bg-surface-2 hover:text-text"
        aria-label="Close"
        title="Close (Esc)"
        @click="emit('close')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M18 6 6 18M6 6l12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
    <div
      ref="list"
      role="listbox"
      aria-label="Check types"
      :aria-activedescendant="active ? optionId(active) : undefined"
      tabindex="0"
      class="flex max-h-[min(640px,70vh)] flex-col gap-14 overflow-auto px-16 py-14 outline-none"
      @keydown="onKeydown"
    >
      <div
        v-for="row in rows"
        :key="row[0]!.id"
        :class="row.length > 1 ? 'grid grid-cols-2 gap-14 max-md:grid-cols-1' : ''"
      >
        <div
          v-for="group in row"
          :key="group.id"
          role="group"
          :aria-label="group.label"
          class="flex min-w-0 flex-col gap-8"
        >
          <div class="text-12 font-semibold text-text-2">{{ group.label }}</div>
          <div
            class="grid gap-8"
            :class="group.cards.length > 1 ? 'grid-cols-2 max-md:grid-cols-1' : 'grid-cols-1'"
          >
            <div
              v-for="card in group.cards"
              :id="optionId(card.type)"
              :key="card.type"
              role="option"
              :aria-selected="active === card.type ? 'true' : 'false'"
              :aria-disabled="disabled(card.type) ? 'true' : undefined"
              class="flex min-w-0 flex-col gap-4 rounded-6 border px-12 py-10 text-left"
              :class="[
                disabled(card.type)
                  ? 'cursor-not-allowed border-border bg-surface-2'
                  : active === card.type
                    ? 'cursor-pointer border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
                    : suggested?.type === card.type
                      ? 'cursor-pointer border-accent bg-surface'
                      : 'cursor-pointer border-border bg-surface hover:border-accent',
              ]"
              :data-type="card.type"
              @click="choose(card)"
              @mousemove="!disabled(card.type) && (active = card.type)"
            >
              <span
                v-if="suggested?.type === card.type && !disabled(card.type)"
                class="flex flex-wrap items-center gap-6"
              >
                <span class="chip h-18 bg-accent text-11 text-on-accent">Suggested</span>
                <span class="text-11 leading-16 text-accent"
                  ><CodeText :text="suggested.reason"
                /></span>
              </span>
              <span class="flex items-baseline justify-between gap-8">
                <b class="text-13" :class="disabled(card.type) ? 'text-text-3' : ''">{{
                  CHECK_TYPE_NAMES[card.type]
                }}</b>
                <span class="font-mono text-11 text-text-3">{{ card.type }}</span>
              </span>
              <span
                class="text-12 leading-18"
                :class="disabled(card.type) ? 'text-text-3' : 'text-text-2'"
                >{{ card.what }}</span
              >
              <span class="text-12 leading-18 text-text-3"
                ><b class="font-medium text-text-2">Use for</b> <CodeText :text="card.use"
              /></span>
              <span
                v-if="card.tags.length || (mode === 'replace' && card.type === currentType)"
                class="mt-2 flex flex-wrap gap-4"
              >
                <span
                  v-if="mode === 'replace' && card.type === currentType"
                  class="tag border-text bg-text text-bg"
                  >current</span
                >
                <span
                  v-for="tag in card.tags"
                  :key="tag"
                  class="tag"
                  :class="
                    tag === 'partial credit' ? 'border-accent bg-accent-soft text-accent' : ''
                  "
                  >{{ tag }}</span
                >
              </span>
              <span
                v-if="mode === 'replace' && card.type === currentType"
                class="text-12 text-text-3"
                >This is the current type.</span
              >
              <span
                v-if="card.type === 'verifier_script' && !hasScripts"
                class="text-12 leading-18 text-ung-text"
                >No scripts in <code>verify/</code>. Add one on disk, then reload.</span
              >
              <span
                v-else-if="card.type === 'verifier_script' && !disabled(card.type)"
                class="mt-4 flex flex-col gap-4"
                @click.stop
              >
                <label :for="scriptId" class="text-12 font-medium text-text-2">Script</label>
                <select
                  :id="scriptId"
                  :ref="keepScriptField"
                  v-model="script"
                  class="input sm font-mono"
                  :aria-invalid="askingScript ? 'true' : 'false'"
                  :aria-describedby="askingScript ? `${scriptId}-ask` : undefined"
                  data-testid="picker-script"
                  @change="onScriptChange"
                  @keydown="onScriptKeydown"
                >
                  <option v-if="!script" :value="null" disabled>Choose a script…</option>
                  <option v-for="name in scriptChoices" :key="name" :value="name">
                    {{ name }}
                  </option>
                </select>
                <span
                  v-if="askingScript"
                  :id="`${scriptId}-ask`"
                  role="alert"
                  class="text-12 text-ung-text"
                  data-testid="picker-script-ask"
                  >{{ CHOOSE_SCRIPT_FIRST }}</span
                >
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="flex flex-col gap-4 border-t border-border px-16 py-10">
      <span class="text-12 text-text-3"
        ><b class="font-semibold text-text-2">↑ ↓</b> move ·
        <b class="font-semibold text-text-2">Enter</b>
        {{ mode === 'replace' ? 'changes the type' : 'adds' }} ·
        <b class="font-semibold text-text-2">Esc</b> closes and returns to
        {{ mode === 'replace' ? 'the card' : '+ Add check' }}</span
      >
      <span class="text-12 text-text-3"
        >Choosing a card adds it, expanded. Default keys: <code>answer</code> for the first answer
        check, then <code>file</code>, <code>tool_use</code>, <code>judge</code>,
        <code>script</code>, with <code>_2</code> for duplicates. No check calls a model while you
        author.</span
      >
    </div>
  </div>
</template>

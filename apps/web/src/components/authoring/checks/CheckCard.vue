<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import type { JsonValue, ScorerType } from '@hermes-evals/shared';
import type { DraftSelfCheckResult, TaskFormCheck } from '@/api/types/authoring';
import type { TryState } from '@/stores/draftTaskTools';
import CodeText from '../editors/CodeText.vue';
import AnswerFields from './AnswerFields.vue';
import CheckCardHeader from './CheckCardHeader.vue';
import { CHECK_TYPE_NAMES, effectivePath, isAnswerCheck, ruleLine } from './checkText';
import ExpectedRunPanel from './ExpectedRunPanel.vue';
import FileCheckFields from './FileCheckFields.vue';
import JudgeFields from './JudgeFields.vue';
import ScriptFields from './ScriptFields.vue';
import ToolUseFields from './ToolUseFields.vue';
import TryItPanel from './TryItPanel.vue';
import type { Params } from './params';

/**
 * One check of the task (Components 5, CheckCard; SA.7, SA.7a). Collapsed it is one row:
 * handle, key, type, the Primary radio, the check in plain words and the last result.
 * Expanded it shows the type's settings and a plain rule line, Try it for answer checks,
 * the expected-workspace run for a File check, and for a Verifier script its source,
 * read-only. The ⋯ menu holds Change type…, Duplicate check and Delete, which asks first.
 * Every change is emitted whole (`update`) and the editor autosaves it.
 */
const props = withDefaults(
  defineProps<{
    check: TaskFormCheck;
    answerPath: string | null;
    readonly?: boolean;
    /** The API's messages for this check's fields, by param name, and for its key. */
    errors?: Record<string, string>;
    keyError?: string | null;
    /** The value the check reads in the reference; undefined when there is none. */
    referenceValue?: JsonValue | undefined;
    /** The reference is valid JSON and has no value at the path the check reads. */
    referenceMissing?: boolean;
    tryState?: TryState | null;
    /** This key's results in the last self-check. */
    selfCheckResults?: DraftSelfCheckResult[];
    selfCheckSeconds?: number | null;
    selfCheckStale?: boolean;
    selfCheckRunning?: boolean;
    expectedFolder?: string | null;
    scripts?: Array<{ path: string; sizeBytes: number; sha256: string }>;
    scriptSource?: string | null;
    scriptSourceError?: string | null;
    rubric?: string;
    /** "Primary: the first check is primary. …", "`reads_ledger` is now primary." */
    primaryNote?: string | null;
    changedFrom?: { from: ScorerType; dropped: string[] } | null;
    /** A card that just arrived: outlined in accent, focus in Path (or Key). */
    fresh?: boolean;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
  }>(),
  {
    readonly: false,
    errors: () => ({}),
    keyError: null,
    referenceValue: undefined,
    referenceMissing: false,
    tryState: null,
    selfCheckResults: () => [],
    selfCheckSeconds: null,
    selfCheckStale: false,
    selfCheckRunning: false,
    expectedFolder: null,
    scripts: () => [],
    scriptSource: null,
    scriptSourceError: null,
    rubric: '',
    primaryNote: null,
    changedFrom: null,
    fresh: false,
    canMoveUp: false,
    canMoveDown: false,
  },
);
const emit = defineEmits<{
  update: [check: TaskFormCheck];
  makePrimary: [];
  delete: [];
  duplicate: [];
  changeType: [];
  undoChange: [];
  reply: [text: string];
  runSelfCheck: [];
  rubric: [text: string];
  loadSource: [path: string];
  move: [step: -1 | 1];
}>();
const expanded = defineModel<boolean>('expanded', { default: false });
const tryOpen = ref(false);
const root = ref<HTMLElement | null>(null);
const bodyId = `check-${useId()}`;

const path = computed(() => effectivePath(props.check, props.answerPath));
const answer = computed(() => isAnswerCheck(props.check.type));
const hasErrors = computed(() => Object.keys(props.errors).length > 0 || !!props.keyError);
const rule = computed(() => {
  if (Object.keys(props.errors).length > 0) {
    const what = {
      numeric_tolerance: 'the tolerance',
      json_match: 'the share',
      text_match: 'the share',
      file_check: 'the format',
    } as Record<string, string>;
    return `Fix ${what[props.check.type] ?? 'the settings'} to see when this check passes.`;
  }
  return ruleLine(props.check, props.referenceValue);
});

function setParams(params: Params): void {
  emit('update', { ...props.check, params });
}
function setKey(key: string): void {
  emit('update', { ...props.check, key });
}

onMounted(async () => {
  if (props.check.type === 'verifier_script' && typeof props.check.params.script === 'string') {
    emit('loadSource', `verify/${props.check.params.script}`);
  }
  if (!props.fresh) return;
  expanded.value = true;
  await nextTick();
  const target =
    root.value?.querySelector<HTMLElement>('[data-field="path"]') ??
    root.value?.querySelector<HTMLElement>('[data-field="key"]');
  target?.focus();
});

function toggle(): void {
  expanded.value = !expanded.value;
  if (
    expanded.value &&
    props.check.type === 'verifier_script' &&
    typeof props.check.params.script === 'string'
  ) {
    emit('loadSource', `verify/${props.check.params.script}`);
  }
}
</script>

<template>
  <div
    ref="root"
    class="relative rounded-6 border bg-surface transition-shadow duration-[1500ms]"
    :class="[
      fresh
        ? 'border-accent shadow-[0_0_0_1px_var(--accent),0_0_0_5px_var(--accent-soft)]'
        : 'border-border',
      expanded && !fresh ? 'shadow-[0_0_0_1px_var(--border-strong)]' : '',
    ]"
    :data-testid="`check-card-${check.key}`"
    :data-type="check.type"
  >
    <CheckCardHeader
      :check="check"
      :answer-path="answerPath"
      :expanded="expanded"
      :body-id="bodyId"
      :readonly="readonly"
      :invalid="hasErrors"
      :reference-missing="referenceMissing && answer"
      :reference-status="tryState?.reference?.status ?? null"
      :expected-status="
        selfCheckStale ? null : (selfCheckResults.find((r) => r.expect === 'pass')?.status ?? null)
      "
      :primary-note="primaryNote"
      :can-move-up="canMoveUp"
      :can-move-down="canMoveDown"
      @toggle="toggle"
      @make-primary="emit('makePrimary')"
      @delete="emit('delete')"
      @duplicate="emit('duplicate')"
      @change-type="emit('changeType')"
      @move="emit('move', $event)"
    />
    <div
      v-if="expanded"
      :id="bodyId"
      class="flex flex-col gap-14 border-t border-border px-16 pt-14 pb-16"
    >
      <div
        v-if="changedFrom"
        role="status"
        class="flex flex-wrap items-center gap-x-10 gap-y-6 rounded-4 border border-border-strong bg-accent-soft px-10 py-8 text-12 leading-18"
      >
        <span
          >Changed from {{ CHECK_TYPE_NAMES[changedFrom.from] }}.<template
            v-if="changedFrom.dropped.length"
          >
            Dropped: {{ changedFrom.dropped.join(', ') }}.</template
          ></span
        >
        <button type="button" class="linkbtn text-12" @click="emit('undoChange')">Undo</button>
      </div>
      <AnswerFields
        v-if="answer"
        :type="check.type"
        :check-key="check.key"
        :key-error="keyError"
        :params="check.params"
        :errors="errors"
        :primary="check.primary"
        :answer-path="answerPath"
        :readonly="readonly"
        @params="setParams"
        @key="setKey"
      />
      <FileCheckFields
        v-else-if="check.type === 'file_check'"
        :check-key="check.key"
        :key-error="keyError"
        :params="check.params"
        :errors="errors"
        :readonly="readonly"
        @params="setParams"
        @key="setKey"
      />
      <ToolUseFields
        v-else-if="check.type === 'trajectory_match'"
        :check-key="check.key"
        :key-error="keyError"
        :params="check.params"
        :errors="errors"
        :readonly="readonly"
        @params="setParams"
        @key="setKey"
      />
      <JudgeFields
        v-else-if="check.type === 'llm_judge'"
        :check-key="check.key"
        :key-error="keyError"
        :params="check.params"
        :errors="errors"
        :rubric="rubric"
        :readonly="readonly"
        @params="setParams"
        @key="setKey"
        @rubric="emit('rubric', $event)"
      />
      <ScriptFields
        v-else
        :check-key="check.key"
        :key-error="keyError"
        :params="check.params"
        :errors="errors"
        :scripts="scripts"
        :source="scriptSource"
        :source-error="scriptSourceError"
        :readonly="readonly"
        @params="setParams"
        @key="setKey"
      />
      <div
        v-if="rule"
        class="rounded-4 bg-surface-2 px-10 py-8 text-12 leading-18 text-text-2"
        data-testid="rule-line"
      >
        <CodeText :text="rule" />
      </div>
      <TryItPanel
        v-if="answer"
        v-model:open="tryOpen"
        :state="tryState"
        :path="path"
        :readonly="readonly"
        @reply="emit('reply', $event)"
      />
      <ExpectedRunPanel
        v-else-if="check.type === 'file_check'"
        :results="selfCheckResults"
        :seconds="selfCheckSeconds"
        :stale="selfCheckStale"
        :running="selfCheckRunning"
        :expected-folder="expectedFolder"
        :disabled="readonly"
        @run="emit('runSelfCheck')"
      />
      <div
        v-else-if="check.type === 'trajectory_match' || check.type === 'llm_judge'"
        class="flex items-center gap-8 rounded-4 border border-dashed border-border-strong px-10 py-8"
      >
        <span class="size-8 flex-none rounded-full border-[1.5px] border-que" aria-hidden="true" />
        <span class="text-12 text-text-2"
          >Checked when runs are scored. A self-check can't test this without a real run.</span
        >
      </div>
    </div>
  </div>
</template>

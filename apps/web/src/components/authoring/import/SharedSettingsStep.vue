<script setup lang="ts">
import { answerInstructions, type JsonValue, type ScorerType } from '@hermes-evals/shared';
import { computed } from 'vue';
import type { TaskFormCheck, TaskImportSettings } from '@/api/types/authoring';
import ChipListInput from '@/components/resources/ChipListInput.vue';
import ZoneLabel from '@/components/suites/ZoneLabel.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import { formatBytes } from '@/lib/format';
import { checkSentence, newCheckFor, TYPE_LABELS, valueAtAnswer } from './importSettings';

/**
 * Step 3 of Import tasks (SA.9): what every imported task shares. Workspace files (copied
 * from a task of the draft, uploaded here, or none), the answer path each reference value is
 * put at, the checks (a new one suggested by the reference values, or a task's), the limits,
 * and the paragraph asking for the fenced JSON answer, previewed as it will be appended.
 * Each can be changed per task later in the editor.
 */
const props = defineProps<{
  /** The draft's task keys, for "Copy from a task". */
  taskKeys: string[];
  /** A reference as the first row gives it, for the suggestion and the paragraph's shape. */
  sampleReference: JsonValue | undefined;
}>();
const settings = defineModel<TaskImportSettings>('settings', { required: true });
const uploads = defineModel<File[]>('uploads', { default: () => [] });

const workspaceFrom = computed(() => settings.value.workspace.from);
const checksFrom = computed(() => settings.value.checks.from);
const answerPath = computed(() => settings.value.answerPath ?? '');
const sampleValue = computed(() => valueAtAnswer(props.sampleReference, settings.value.answerPath));
const suggested = computed<ScorerType>(() => newCheckFor(sampleValue.value).type);

function setWorkspace(from: 'task' | 'upload' | 'none'): void {
  const key = props.taskKeys[0];
  settings.value = {
    ...settings.value,
    workspace:
      from === 'task' && key
        ? { from: 'task', key }
        : from === 'upload'
          ? { from: 'upload' }
          : { from: 'none' },
  };
}
function setWorkspaceTask(key: string): void {
  settings.value = { ...settings.value, workspace: { from: 'task', key } };
}
function setChecks(from: 'new' | 'task'): void {
  const key = props.taskKeys[0];
  settings.value = {
    ...settings.value,
    checks:
      from === 'task' && key
        ? { from: 'task', key }
        : { from: 'new', checks: [newCheckFor(sampleValue.value)] },
  };
}
function setChecksTask(key: string): void {
  settings.value = { ...settings.value, checks: { from: 'task', key } };
}
function setAnswerPath(value: string): void {
  settings.value = { ...settings.value, answerPath: value.trim() === '' ? null : value };
}
function setLimit(field: 'maxTurns' | 'runBudgetSeconds', value: string): void {
  const n = Number(value);
  settings.value = {
    ...settings.value,
    limits: { ...settings.value.limits, [field]: Number.isInteger(n) ? n : 0 },
  };
}
const toolsets = computed({
  get: () => settings.value.limits.toolsetsNeeded,
  set: (toolsetsNeeded: string[]) =>
    (settings.value = { ...settings.value, limits: { ...settings.value.limits, toolsetsNeeded } }),
});
function onUpload(event: Event): void {
  const input = event.target as HTMLInputElement;
  uploads.value = [...uploads.value, ...Array.from(input.files ?? [])];
  input.value = '';
}
const newCheck = computed<TaskFormCheck | null>(() =>
  settings.value.checks.from === 'new' ? (settings.value.checks.checks[0] ?? null) : null,
);
const paragraph = computed(() =>
  answerInstructions(settings.value.answerPath, props.sampleReference),
);
const SEGMENT =
  'h-28 border-0 border-r border-border-strong px-10 text-12 last:border-r-0 aria-checked:bg-surface-3 aria-checked:font-semibold';
</script>

<template>
  <div class="flex flex-col" data-testid="shared-settings">
    <div class="grid grid-cols-[220px_minmax(0,1fr)] gap-20 border-b border-border py-14">
      <div>
        <b class="font-medium">Workspace files</b>
        <div class="mt-6"><ZoneLabel zone="visible" /></div>
        <p class="mt-2 text-12 text-text-3">Copied into every imported task.</p>
      </div>
      <div class="flex flex-col gap-8">
        <div
          role="radiogroup"
          aria-label="Workspace files"
          class="inline-flex self-start overflow-hidden rounded-4 border border-border-strong"
        >
          <button
            type="button"
            role="radio"
            :aria-checked="workspaceFrom === 'task'"
            :disabled="taskKeys.length === 0"
            :class="SEGMENT"
            @click="setWorkspace('task')"
          >
            Copy from a task
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="workspaceFrom === 'upload'"
            :class="SEGMENT"
            @click="setWorkspace('upload')"
          >
            Upload
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="workspaceFrom === 'none'"
            :class="SEGMENT"
            @click="setWorkspace('none')"
          >
            None
          </button>
        </div>
        <div v-if="settings.workspace.from === 'task'" class="flex items-center gap-8">
          <select
            class="input sm w-260 font-mono"
            aria-label="Task to copy workspace files from"
            :value="settings.workspace.key"
            @change="setWorkspaceTask(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="key in taskKeys" :key="key" :value="key">{{ key }}</option>
          </select>
          <span class="text-12 text-text-3">Its workspace files, as they are in the draft.</span>
        </div>
        <div v-else-if="settings.workspace.from === 'upload'" class="flex flex-col gap-6">
          <label class="btn sm self-start">
            Choose files
            <input
              type="file"
              multiple
              class="hidden"
              data-testid="workspace-upload"
              @change="onUpload"
            />
          </label>
          <ul v-if="uploads.length" class="flex flex-col gap-2 text-12">
            <li v-for="(f, i) in uploads" :key="`${f.name}-${i}`">
              <code>/workspace/{{ f.name }}</code>
              <span class="text-text-3"> · {{ formatBytes(f.size) }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-[220px_minmax(0,1fr)] gap-20 border-b border-border py-14">
      <div>
        <b class="font-medium">Answer path</b>
        <div class="mt-6"><ZoneLabel zone="hidden" /></div>
        <p class="mt-2 text-12 text-text-3">
          The value inside the fenced JSON block that the primary check reads.
        </p>
      </div>
      <div class="flex flex-col gap-8">
        <input
          class="input w-260 font-mono text-12"
          aria-label="Answer path"
          :value="answerPath"
          spellcheck="false"
          data-testid="answer-path"
          @input="setAnswerPath(($event.target as HTMLInputElement).value)"
        />
        <span v-if="answerPath" class="text-12 text-text-3"
          >Each reference becomes <code>{ "{{ answerPath }}": &lt;expected&gt; }</code>.</span
        >
      </div>
    </div>

    <div class="grid grid-cols-[220px_minmax(0,1fr)] gap-20 border-b border-border py-14">
      <div>
        <b class="font-medium">Checks</b>
        <div class="mt-6"><ZoneLabel zone="hidden" /></div>
        <p class="mt-2 text-12 text-text-3">The same checks for every imported task.</p>
      </div>
      <div class="flex flex-col gap-8">
        <div
          role="radiogroup"
          aria-label="Checks"
          class="inline-flex self-start overflow-hidden rounded-4 border border-border-strong"
        >
          <button
            type="button"
            role="radio"
            :aria-checked="checksFrom === 'task'"
            :disabled="taskKeys.length === 0"
            :class="SEGMENT"
            @click="setChecks('task')"
          >
            Copy from a task
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="checksFrom === 'new'"
            :class="SEGMENT"
            @click="setChecks('new')"
          >
            New {{ TYPE_LABELS[suggested] }}
          </button>
        </div>
        <template v-if="newCheck">
          <div
            class="flex flex-wrap items-center gap-10 rounded-6 border border-border bg-surface px-12 py-8"
            data-testid="new-check"
          >
            <span class="font-mono font-semibold">{{ newCheck.key }}</span>
            <BaseTag>{{ newCheck.type }}</BaseTag>
            <span class="chip bg-surface-3 text-text">primary</span>
            <span class="text-text-2">{{ checkSentence(newCheck, settings.answerPath) }}</span>
          </div>
          <span v-if="taskKeys.length" class="text-12 text-text-3"
            >Or copy the checks of a task, e.g. <span class="font-mono">{{ taskKeys[0] }}</span
            >.</span
          >
        </template>
        <select
          v-else-if="settings.checks.from === 'task'"
          class="input sm w-260 font-mono"
          aria-label="Task to copy checks from"
          :value="settings.checks.key"
          @change="setChecksTask(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="key in taskKeys" :key="key" :value="key">{{ key }}</option>
        </select>
      </div>
    </div>

    <div class="grid grid-cols-[220px_minmax(0,1fr)] gap-20 border-b border-border py-14">
      <div>
        <b class="font-medium">Limits</b>
        <p class="mt-2 text-12 text-text-3">Guidance shown on New experiment.</p>
      </div>
      <div class="flex flex-wrap items-center gap-12">
        <label class="text-12 text-text-3" for="import-max-turns">Max turns</label>
        <input
          id="import-max-turns"
          class="input w-80 font-mono text-12"
          inputmode="numeric"
          :value="settings.limits.maxTurns"
          @input="setLimit('maxTurns', ($event.target as HTMLInputElement).value)"
        />
        <label class="text-12 text-text-3" for="import-budget">Run budget</label>
        <input
          id="import-budget"
          class="input w-90 font-mono text-12"
          inputmode="numeric"
          :value="settings.limits.runBudgetSeconds"
          @input="setLimit('runBudgetSeconds', ($event.target as HTMLInputElement).value)"
        />
        <span class="text-12 text-text-3">s</span>
        <span class="text-12 text-text-3">Toolsets needed</span>
        <ChipListInput
          v-model="toolsets"
          label="Toolsets needed"
          input-label="Add a toolset"
          placeholder="file"
          :input-width="90"
        />
      </div>
    </div>

    <div class="grid grid-cols-[220px_minmax(0,1fr)] gap-20 py-14">
      <div>
        <b class="font-medium">Answer instructions</b>
        <p class="mt-2 text-12 text-text-3">Without them, answer checks are ungradable.</p>
      </div>
      <div class="flex flex-col gap-8">
        <label class="inline-flex items-center gap-10">
          <input
            type="checkbox"
            role="switch"
            :checked="settings.appendAnswerInstructions"
            data-testid="append-instructions"
            @change="
              settings = {
                ...settings,
                appendAnswerInstructions: ($event.target as HTMLInputElement).checked,
              }
            "
          />
          <b class="font-medium">Append answer instructions to every prompt</b>
        </label>
        <template v-if="settings.appendAnswerInstructions">
          <span
            ><ZoneLabel zone="visible" label="Added to the prompt · visible to the agent"
          /></span>
          <span class="text-12 text-text-3"
            >Appended paragraph, built from the answer path <code>{{ answerPath || '—' }}</code
            >:</span
          >
          <pre
            class="rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
            data-testid="instructions-preview"
            >{{ paragraph }}</pre>
        </template>
      </div>
    </div>
  </div>
</template>

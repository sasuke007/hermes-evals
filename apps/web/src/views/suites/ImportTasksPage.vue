<script setup lang="ts">
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { errorMessage } from '@/api/client';
import type {
  SuiteDraftView,
  TaskImportPreview,
  TaskImportSettings,
  TaskTableFile,
} from '@/api/types/authoring';
import type { UploadProblem } from '@/api/types/resources';
import ColumnMapper from '@/components/authoring/import/ColumnMapper.vue';
import { mappingReady } from '@/components/authoring/import/columnMapping';
import ImportPreviewTable from '@/components/authoring/import/ImportPreviewTable.vue';
import ImportSteps from '@/components/authoring/import/ImportSteps.vue';
import { initialSettings, sampleReference } from '@/components/authoring/import/importSettings';
import SharedSettingsStep from '@/components/authoring/import/SharedSettingsStep.vue';
import TaskFileStep from '@/components/authoring/import/TaskFileStep.vue';
import PageContainer from '@/components/layout/PageContainer.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { plural } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import { draftLocation } from './authoringRoutes';

/**
 * Import tasks from CSV or JSONL (ImportTasks board, SA.9), for many questions over the same
 * files: upload a file the API reads (5 MB, 500 rows), map its columns (ColumnMapper), set
 * what every task shares, then preview the tasks and fix any key that cannot be a folder
 * name. Add puts them in the suite's draft as added tasks; nothing is written to ./suites
 * until the draft is saved. Opening the page opens the suite's draft.
 */
const props = defineProps<{ folder: string }>();

const store = useSuiteAuthoringStore();
const router = useRouter();

const draft = ref<SuiteDraftView | null>(null);
const draftError = ref<string | null>(null);
async function openDraft(): Promise<void> {
  draftError.value = null;
  try {
    draft.value = await store.startDraft(props.folder);
  } catch (err) {
    draftError.value = errorMessage(err);
  }
}
onMounted(() => void openDraft());

const step = ref(1);
const source = ref<File | null>(null);
const file = ref<TaskTableFile | null>(null);
const rejected = ref<{ name: string; problems: UploadProblem[] }[]>([]);
const reading = ref(false);
const settings = ref<TaskImportSettings | null>(null);
const uploads = ref<File[]>([]);
const preview = ref<TaskImportPreview | null>(null);
const previewing = ref(false);
const actionError = ref<string | null>(null);
const adding = ref(false);

const taskKeys = computed(() =>
  (draft.value?.tasks ?? []).filter((t) => t.state !== 'removed').map((t) => t.key),
);

async function pick(picked: File): Promise<void> {
  actionError.value = null;
  if (picked.size > AUTHORING_LIMITS.taskImportMaxBytes) {
    rejected.value = [
      ...rejected.value,
      {
        name: picked.name,
        problems: [
          { title: `\`${picked.name}\`: over 5 MB. The limit is 5 MB per import.`, detail: '' },
        ],
      },
    ];
    return;
  }
  reading.value = true;
  try {
    const validation = await store.validateTasks(props.folder, picked, null, [], taskKeys.value);
    if (validation.file) {
      source.value = picked;
      file.value = validation.file;
      settings.value = initialSettings(validation.file, taskKeys.value);
      preview.value = null;
    } else {
      rejected.value = [...rejected.value, { name: picked.name, problems: validation.problems }];
    }
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    reading.value = false;
  }
}

/** The mapping's two-way binding, through the settings. */
const mapping = computed({
  get: () => settings.value?.mapping ?? [],
  set: (value) => settings.value && (settings.value = { ...settings.value, mapping: value }),
});
const keyPrefix = computed({
  get: () => settings.value?.keyPrefix ?? '',
  set: (value: string) =>
    settings.value && (settings.value = { ...settings.value, keyPrefix: value.trim() || null }),
});
const sample = computed(() =>
  file.value && settings.value
    ? sampleReference(file.value, settings.value.mapping, settings.value.answerPath)
    : undefined,
);

async function buildPreview(): Promise<void> {
  if (!source.value || !settings.value) return;
  previewing.value = true;
  actionError.value = null;
  try {
    const validation = await store.validateTasks(
      props.folder,
      source.value,
      settings.value,
      settings.value.workspace.from === 'upload' ? uploads.value : [],
      taskKeys.value,
    );
    preview.value = validation.preview;
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    previewing.value = false;
  }
}

function fix(row: number, key: string): void {
  if (!settings.value) return;
  const others = settings.value.keyFixes.filter((f) => f.row !== row);
  settings.value = { ...settings.value, keyFixes: [...others, { row, key }] };
  void buildPreview();
}

function go(next: number): void {
  step.value = next;
  if (next === 4) void buildPreview();
}

async function add(): Promise<void> {
  if (!source.value || !settings.value || adding.value || (preview.value?.fixCount ?? 1) > 0)
    return;
  adding.value = true;
  actionError.value = null;
  try {
    const outcome = await store.addImportedTasks(
      props.folder,
      source.value,
      settings.value,
      settings.value.workspace.from === 'upload' ? uploads.value : [],
      taskKeys.value,
    );
    if (outcome.kind === 'added') await router.push(draftLocation(props.folder));
    else {
      if (outcome.preview) preview.value = outcome.preview;
      actionError.value = outcome.message;
    }
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    adding.value = false;
  }
}

watch(
  () => props.folder,
  () => {
    step.value = 1;
    void openDraft();
  },
);

const canMap = computed(() => !!file.value);
const mappingOk = computed(() => mappingReady(mapping.value));
const problems = computed(
  () => preview.value?.messages.filter((m) => m.severity === 'problem') ?? [],
);
const notes = computed(() => preview.value?.messages.filter((m) => m.severity === 'info') ?? []);
const fixLine = computed(() =>
  preview.value && preview.value.fixCount > 0
    ? `${plural(preview.value.fixCount, 'row')} ${preview.value.fixCount === 1 ? 'needs' : 'need'} a fix`
    : null,
);
const addDisabled = computed(
  () => !preview.value || preview.value.fixCount > 0 || problems.value.length > 0 || adding.value,
);

const draftTo = computed(() => draftLocation(props.folder));
const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
  { label: props.folder, to: draftTo.value },
  { label: 'Import tasks' },
]);
</script>

<template>
  <PageContainer variant="detail" :gap="28">
    <PageHeader title="Import tasks from CSV or JSONL" :breadcrumbs="breadcrumbs">
      <template #meta>
        <p class="max-w-900 text-text-2">
          For many questions over the same files. Each row becomes one task with its own prompt and
          reference; workspace files, checks and limits are shared. The tasks are added to the
          draft.
        </p>
      </template>
    </PageHeader>

    <ErrorBanner
      v-if="draftError"
      :title="`Could not open the draft of ${folder}`"
      :detail="draftError"
      hint="The draft is stored by the api service, not in this tab, so nothing is lost. Retry opens it again."
      retry-label="Retry"
      @retry="openDraft"
    />

    <section
      class="flex flex-col gap-16 rounded-6 border border-border bg-surface px-20 pt-16 pb-20"
      :data-step="step"
      data-testid="import-tasks"
    >
      <ImportSteps :current="step" />

      <template v-if="step === 1">
        <TaskFileStep :file="file" :rejected="rejected" :reading="reading" @pick="pick" />
      </template>

      <template v-else-if="step === 2 && file && settings">
        <p class="text-text-2">
          One row per column of <code>{{ file.fileName }}</code
          >. Choose what each column becomes in the new tasks.
        </p>
        <ColumnMapper
          v-model:mapping="mapping"
          v-model:key-prefix="keyPrefix"
          :columns="file.columns"
        />
      </template>

      <template v-else-if="step === 3 && settings">
        <p class="text-text-2">
          Applied to every imported task. Each one can be changed later in the task editor.
        </p>
        <SharedSettingsStep
          v-model:settings="settings"
          v-model:uploads="uploads"
          :task-keys="taskKeys"
          :sample-reference="sample"
        />
      </template>

      <template v-else-if="step === 4">
        <p class="text-text-2">
          {{ plural(preview?.addCount ?? file?.rowCount ?? 0, 'task') }} will be added to the draft
          of <code>{{ folder }}</code
          ><template v-if="draft?.base"> (based on v{{ draft.base.versionNumber }})</template>.
          Nothing is written to <code>./suites</code> until you save the draft.
        </p>
        <div
          v-if="previewing && !preview"
          class="h-160 animate-shimmer rounded-6 border border-border bg-surface-2"
          aria-busy="true"
        />
        <ImportPreviewTable v-if="preview" :preview="preview" @fix="fix" />
        <div v-if="problems.length || notes.length" class="flex flex-col gap-4">
          <span
            v-for="m in problems"
            :key="m.message"
            role="alert"
            class="text-12 text-fail-text"
            >{{ m.message }}</span
          >
          <span v-for="m in notes" :key="m.message" class="text-12 text-text-3">{{
            m.message
          }}</span>
        </div>
        <p class="text-12 text-text-3">
          Answer checks are checked against each reference as the preview builds; self-checks run
          when you save, or per task in the editor.
        </p>
      </template>

      <ErrorBanner v-if="actionError" title="That did not work" :detail="actionError" compact />

      <div class="flex items-center justify-between border-t border-border pt-14">
        <RouterLink v-if="step === 1" class="btn" :to="draftTo">Cancel</RouterLink>
        <button v-else type="button" class="btn" @click="go(step - 1)">Back</button>
        <button
          v-if="step === 1"
          type="button"
          class="btn primary"
          :disabled="!canMap"
          data-testid="next-step"
          @click="go(2)"
        >
          Next: map columns
        </button>
        <button
          v-else-if="step === 2"
          type="button"
          class="btn primary"
          :disabled="!mappingOk"
          data-testid="next-step"
          @click="go(3)"
        >
          Next: shared settings
        </button>
        <button
          v-else-if="step === 3"
          type="button"
          class="btn primary"
          data-testid="next-step"
          @click="go(4)"
        >
          Next: preview
        </button>
        <span v-else class="inline-flex items-center gap-12">
          <span v-if="fixLine" class="text-12 text-err-text" data-testid="fix-line">{{
            fixLine
          }}</span>
          <button
            type="button"
            class="btn primary"
            :disabled="addDisabled"
            :title="fixLine ?? undefined"
            data-testid="add-tasks"
            @click="add"
          >
            {{ adding ? 'Adding…' : `Add ${plural(preview?.addCount ?? 0, 'task')} to the draft` }}
          </button>
        </span>
      </div>
    </section>

    <div
      v-if="step === 4"
      role="status"
      class="flex items-start gap-10 rounded-6 border border-border bg-surface-2 px-12 py-10"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
        class="mt-2 flex-none text-accent"
      >
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M8 7.2v4M8 4.8h.01"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
      <span
        ><b>After adding,</b>
        <span class="text-text-2">
          you return to the suite in draft mode with {{ preview?.addCount ?? 0 }}
          <span class="tag">added</span> rows. Self-checks run when you save, or per task in the
          editor.</span
        ></span
      >
    </div>
  </PageContainer>
</template>

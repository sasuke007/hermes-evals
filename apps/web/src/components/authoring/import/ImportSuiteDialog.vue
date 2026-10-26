<script setup lang="ts">
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { errorMessage } from '@/api/client';
import type { SuiteZipValidation } from '@/api/types/authoring';
import UploadDropZone from '@/components/resources/UploadDropZone.vue';
import CodeText from '@/components/suites/CodeText.vue';
import BaseDialog from '@/components/ui/BaseDialog.vue';
import BaseTooltip from '@/components/ui/BaseTooltip.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { formatBytes } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import { useSuitesStore } from '@/stores/suites';
import { draftLocation } from '@/views/suites/authoringRoutes';
import ZipProblems from './ZipProblems.vue';
import ZipRootFilesNote from './ZipRootFilesNote.vue';
import ZipScriptsPanel from './ZipScriptsPanel.vue';
import ZipTaskList from './ZipTaskList.vue';
import { nameHolders } from '../new-suite/suiteName';
import { newNameProblem, taskCountLine, zipChip } from './zipFormat';

/**
 * Import a suite (.zip), in two steps (ImportSuiteDialog board, SA.10; built on the skill
 * upload dialog): drop a zip, which the API reads with the hardened zip reader and checks by
 * the rules a reload uses, running none of its code; then review and import it as the draft
 * of a new suite, every task added, saved as v1 after review. A name another suite holds is
 * imported under a new one, or the existing suite is opened instead. A zip with verifier
 * scripts shows "This suite contains code" and waits for "I trust these scripts" (R7).
 * A rejection stops the import; invalid tasks do not. Files at the suite root other than
 * suite.yaml are named as not imported (Phase 7).
 *
 * Validating shows no file count or self-check name: the validation is one request and runs
 * no code, so there is no step to report (the board draws "self-checking unmatched_lines").
 */
const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ imported: [folder: string] }>();

const store = useSuiteAuthoringStore();
const suites = useSuitesStore();
const router = useRouter();

type Step = 'choose' | 'validating' | 'review';
const step = ref<Step>('choose');
const file = ref<File | null>(null);
const result = ref<SuiteZipValidation | null>(null);
const requestError = ref<string | null>(null);
const tooLarge = ref(false);
/** Name taken: import under `newName`, or open the existing suite. */
const choice = ref<'rename' | 'open'>('rename');
const newName = ref('');
/** Continue was pressed on the name-taken step: the review shows the new name. */
const renamed = ref(false);
const trusted = ref(false);
const importing = ref(false);
const importError = ref<string | null>(null);

function reset(): void {
  step.value = 'choose';
  file.value = null;
  result.value = null;
  requestError.value = null;
  tooLarge.value = false;
  choice.value = 'rename';
  newName.value = '';
  renamed.value = false;
  trusted.value = false;
  importing.value = false;
  importError.value = null;
}
watch(open, (isOpen) => {
  if (isOpen) reset();
});

let attempt = 0;
async function choose(picked: File): Promise<void> {
  const mine = ++attempt;
  reset();
  file.value = picked;
  if (picked.size > AUTHORING_LIMITS.suiteZipMaxBytes) {
    tooLarge.value = true;
    step.value = 'review';
    return;
  }
  step.value = 'validating';
  try {
    const validation = await store.validateZip(picked);
    if (mine !== attempt) return;
    result.value = validation;
    newName.value = validation.nameTaken?.suggestion ?? validation.suite?.name ?? '';
  } catch (err) {
    if (mine === attempt) requestError.value = errorMessage(err);
  } finally {
    if (mine === attempt) step.value = 'review';
  }
}

const stepLabel = computed(() =>
  step.value === 'choose' ? 'Step 1 of 2 · choose file' : 'Step 2 of 2 · review',
);
const rejected = computed(
  () =>
    step.value === 'review' &&
    (tooLarge.value || !!requestError.value || result.value?.outcome === 'rejected'),
);
/** The name-taken question is open (before Continue). */
const asking = computed(() => result.value?.outcome === 'name_taken' && !renamed.value);
const reviewing = computed(() => step.value === 'review' && !!result.value?.token && !asking.value);
/** Names a suite on disk or a draft holds: a new name must be free of both. */
const holders = computed(() => nameHolders(suites.list, store.drafts));
const nameProblem = computed(() =>
  choice.value === 'rename' ? newNameProblem(newName.value.trim(), holders.value) : null,
);
const importName = computed(() =>
  renamed.value ? newName.value.trim() : (result.value?.suite?.name ?? ''),
);
const needsTrust = computed(() => (result.value?.scripts.length ?? 0) > 0 && !trusted.value);
const chip = computed(() => (result.value && reviewing.value ? zipChip(result.value) : null));
const hasInvalid = computed(() => result.value?.tasks.some((t) => t.readiness === 'problems'));

function continueAfterName(): void {
  const r = result.value;
  if (!r?.nameTaken) return;
  if (choice.value === 'open') {
    const existing = suites.list.find((row) => row.path === r.nameTaken!.path);
    open.value = false;
    void router.push(
      existing
        ? { name: ROUTE_NAMES.suite, params: { id: existing.suiteId } }
        : { name: ROUTE_NAMES.suites },
    );
    return;
  }
  if (nameProblem.value) return;
  renamed.value = true;
}

async function confirm(): Promise<void> {
  const token = result.value?.token;
  if (!token || importing.value || needsTrust.value) return;
  importing.value = true;
  importError.value = null;
  try {
    const draft = await store.importZip({
      token,
      name: importName.value,
      trustScripts: trusted.value,
    });
    open.value = false;
    emit('imported', draft.folder);
    void router.push(draftLocation(draft.folder));
  } catch (err) {
    importError.value = errorMessage(err);
  } finally {
    importing.value = false;
  }
}

const IMPORT_NOTE =
  'Import creates a draft of the new suite, with every task `added`, so you can review and fix it before';
</script>

<template>
  <BaseDialog
    v-model:open="open"
    title="Import a suite"
    :width="600"
    body-class="flex flex-col gap-12 p-16"
    data-testid="import-suite-dialog"
  >
    <template #header-extra>
      <span class="text-12 text-text-3" data-testid="step-label">{{ stepLabel }}</span>
    </template>

    <template v-if="step === 'choose'">
      <UploadDropZone
        caption=".zip up to 100 MB · a suite.yaml and one folder per task at its root"
        accept=".zip,application/zip"
        @file="choose"
        >Drop a suite .zip here, or choose a file</UploadDropZone
      >
      <p class="text-12 text-text-3">
        <CodeText :text="IMPORT_NOTE" /> <b>Save as v1</b>. Nothing is written to
        <code>./suites</code> until then.
      </p>
    </template>

    <template v-else-if="file">
      <div
        class="flex items-center justify-between gap-12 rounded-4 border border-border bg-surface-2 px-12 py-10"
        data-testid="upload-file"
      >
        <span class="min-w-0 truncate font-mono text-12" :title="file.name">{{ file.name }}</span>
        <span class="flex flex-none items-center gap-10">
          <span
            class="text-12"
            :class="tooLarge ? 'font-semibold text-fail-text' : 'text-text-3'"
            >{{ formatBytes(result?.sizeBytes ?? file.size) }}</span
          >
          <span
            v-if="chip"
            class="chip"
            :class="
              chip.tone === 'pass' ? 'bg-pass-soft text-pass-text' : 'bg-ung-soft text-ung-text'
            "
            data-testid="zip-chip"
            >{{ chip.text }}</span
          >
        </span>
      </div>

      <template v-if="step === 'validating'">
        <div class="flex items-center gap-10" role="status" data-testid="validating">
          <span
            class="size-14 flex-none animate-spin rounded-full border-2 border-run-soft border-t-run"
            aria-hidden="true"
          />
          <span>Validating…</span>
        </div>
        <div class="h-4 overflow-hidden rounded-2 bg-surface-3" aria-hidden="true">
          <div class="h-full w-1/3 animate-shimmer bg-accent" />
        </div>
        <p class="text-12 text-text-3">
          Paths, links, sizes and every <code>task.yaml</code> are checked before anything is
          stored.
        </p>
      </template>

      <ErrorBanner
        v-else-if="requestError"
        title="The zip could not be checked"
        :detail="requestError"
        compact
      />

      <div
        v-else-if="tooLarge"
        role="alert"
        class="flex items-start gap-10 rounded-4 border border-fail bg-fail-soft px-12 py-10"
        data-testid="zip-rejected"
      >
        <span class="flex flex-col gap-2">
          <b class="text-fail-text">{{ formatBytes(file.size) }} is over the 100 MB limit.</b>
          <span class="text-text-2"
            >Leave out files the suite does not need, then zip it again.</span
          >
        </span>
      </div>

      <ZipProblems v-else-if="result?.outcome === 'rejected'" :problems="result.problems" />

      <template v-else-if="result && asking">
        <div
          role="status"
          class="flex items-start gap-10 rounded-4 border border-ung bg-ung-soft px-12 py-10"
          data-testid="zip-name-taken"
        >
          <b class="text-ung-text"
            ><code>{{ result.suite?.name }}</code> already exists.</b
          >
        </div>
        <div role="radiogroup" aria-label="What to do" class="flex flex-col gap-8">
          <label
            class="flex items-center gap-10 rounded-6 border px-12 py-10"
            :class="choice === 'rename' ? 'border-accent bg-accent-soft' : 'border-border-strong'"
          >
            <input v-model="choice" type="radio" name="zip-name" value="rename" />
            <span class="flex-none">Import as a new suite named</span>
            <input
              v-model="newName"
              class="input w-200 font-mono text-12"
              aria-label="New suite name"
              :aria-invalid="nameProblem ? 'true' : 'false'"
              data-testid="zip-new-name"
              @focus="choice = 'rename'"
            />
          </label>
          <label
            class="flex items-center gap-10 rounded-6 border px-12 py-10"
            :class="choice === 'open' ? 'border-accent bg-accent-soft' : 'border-border-strong'"
          >
            <input v-model="choice" type="radio" name="zip-name" value="open" />
            <span
              >Open <code>{{ result.suite?.name }}</code></span
            >
            <span class="text-12 text-text-3">and leave the zip</span>
          </label>
        </div>
        <span v-if="nameProblem" class="text-12 text-fail-text" role="alert">{{
          nameProblem
        }}</span>
        <span v-else-if="choice === 'rename'" class="text-12 text-text-3"
          >Folder: <code>./suites/{{ newName.trim() }}/</code></span
        >
      </template>

      <template v-else-if="result && reviewing">
        <div
          class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-12 gap-y-4 text-12"
          data-testid="zip-summary"
        >
          <span class="text-text-3">Suite name</span>
          <span class="font-mono"
            >{{ importName
            }}<span v-if="renamed" class="text-12 text-text-3">
              (renamed from {{ result.suite?.name }})</span
            ></span
          >
          <span class="text-text-3">Label</span>
          <span class="font-mono">{{ result.suite?.versionLabel }}</span>
          <span class="text-text-3">Tasks</span>
          <span>{{ taskCountLine(result.tasks) }}</span>
        </div>
        <ZipScriptsPanel
          v-if="result.scripts.length"
          v-model:trusted="trusted"
          :scripts="result.scripts"
          :counts="result.verifyCounts"
        />
        <ZipTaskList :tasks="result.tasks" />
        <ZipRootFilesNote v-if="result.rootFilesNotKept.length" :files="result.rootFilesNotKept" />
        <p v-if="hasInvalid" class="text-12 text-text-3">
          An invalid task can be imported. It is shown with its reason and can't be launched until
          it is fixed.
        </p>
        <p class="text-12 text-text-3">
          <CodeText :text="IMPORT_NOTE" /> <b>Save as v1</b>. Nothing is written to
          <code>./suites</code> until then.
        </p>
        <ErrorBanner
          v-if="importError"
          title="The suite was not imported"
          :detail="importError"
          compact
        />
      </template>
    </template>

    <template #footer>
      <button v-if="rejected" type="button" class="btn" data-primary @click="reset">
        Choose another file
      </button>
      <template v-else>
        <button type="button" class="btn" @click="open = false">Cancel</button>
        <button
          v-if="asking && step === 'review'"
          type="button"
          class="btn primary"
          :disabled="choice === 'rename' && !!nameProblem"
          data-testid="zip-continue"
          @click="continueAfterName"
        >
          Continue
        </button>
        <BaseTooltip
          v-else-if="reviewing"
          text="Confirm the verifier scripts first."
          :enabled="needsTrust"
          v-slot="{ describedBy }"
        >
          <button
            type="button"
            class="btn primary"
            :disabled="importing"
            :aria-disabled="needsTrust ? 'true' : undefined"
            :aria-describedby="describedBy"
            data-testid="zip-import"
            @click="confirm"
          >
            {{ importing ? 'Importing…' : 'Import as a draft' }}
          </button>
        </BaseTooltip>
        <button v-else type="button" class="btn primary" disabled>Import</button>
      </template>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import type { CreateSuiteDraftRequest } from '@hermes-evals/shared';
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { errorMessage } from '@/api/client';
import ImportSuiteDialog from '@/components/authoring/import/ImportSuiteDialog.vue';
import {
  folderLine,
  nameHolders,
  suiteNameProblem,
} from '@/components/authoring/new-suite/suiteName';
import PageContainer from '@/components/layout/PageContainer.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { plural } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import { useSuitesStore } from '@/stores/suites';
import { draftLocation, folderOf } from './authoringRoutes';

/**
 * New suite (NewSuite, NewSuiteStates boards; SA.2; Flow E step 2): one 640px form. The name
 * is also the folder, checked as it is typed against the folder rule and the names suites
 * and drafts hold, with the folder line always under it. Start from Empty, a Copy of a suite
 * (every task at its current version, verifier scripts included: they are on disk already,
 * so no confirmation), or A .zip file, which opens the import dialog. Create is blocked only
 * by suite-level problems and opens the suite as a draft; nothing is written to ./suites
 * until v1 is saved.
 */
const suites = useSuitesStore();
const authoring = useSuiteAuthoringStore();
const router = useRouter();

const name = ref('');
const versionLabel = ref('0.1');
const description = ref('');
const from = ref<'empty' | 'copy'>('empty');
const copyPath = ref<string | null>(null);
const zipOpen = ref(false);
const creating = ref(false);
const createError = ref<string | null>(null);

const listError = ref<string | null>(null);
async function load(): Promise<void> {
  listError.value = null;
  await Promise.all([suites.loadList(), authoring.loadDrafts()]);
  listError.value = suites.listError;
}
onMounted(() => void load());
const ready = computed(() => suites.listLoaded);

const trimmed = computed(() => name.value.trim());
const problem = computed(() =>
  suiteNameProblem(trimmed.value, nameHolders(suites.list, authoring.drafts)),
);
const labelEmpty = computed(() => versionLabel.value.trim() === '');
const usable = computed(() => problem.value === null);

/** Suites to copy: every folder on disk, at its current version. */
const sources = computed(() => suites.list.filter((row) => row.lastLoad.outcome !== 'missing'));
const source = computed(
  () => sources.value.find((row) => row.path === copyPath.value) ?? sources.value[0] ?? null,
);
const sourceLabel = (row: (typeof sources.value)[number]) =>
  `${row.name} · v${row.versionNumber} · ${plural(row.taskCount, 'task')}`;

const blocked = computed(
  () => !usable.value || labelEmpty.value || (from.value === 'copy' && !source.value),
);
const hint = computed<{ text: string; problem: boolean }>(() => {
  const p = problem.value;
  if (p?.kind === 'empty') return { text: 'Enter a name to create the suite.', problem: false };
  if (p?.kind === 'taken')
    return { text: 'Choose another name to create the suite.', problem: true };
  if (p?.kind === 'invalid') return { text: 'Fix the name to create the suite.', problem: true };
  if (labelEmpty.value) return { text: 'Add a version label.', problem: true };
  if (from.value === 'copy' && source.value) {
    return {
      text: `Copies ${plural(source.value.taskCount, 'task')} into a draft of ${trimmed.value}.`,
      problem: false,
    };
  }
  return { text: `Opens ${trimmed.value} as a draft with no tasks.`, problem: false };
});

async function create(): Promise<void> {
  if (blocked.value || creating.value) return;
  creating.value = true;
  createError.value = null;
  const fromRequest: CreateSuiteDraftRequest['from'] =
    from.value === 'copy' && source.value
      ? {
          kind: 'copy',
          suite: folderOf(source.value.path),
          versionNumber: source.value.versionNumber,
        }
      : { kind: 'empty' };
  try {
    const draft = await authoring.createSuite({
      name: trimmed.value,
      versionLabel: versionLabel.value.trim(),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      from: fromRequest,
    });
    await router.push(draftLocation(draft.folder));
  } catch (err) {
    createError.value = errorMessage(err);
  } finally {
    creating.value = false;
  }
}

const breadcrumbs: BreadcrumbItem[] = [
  { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
  { label: 'New' },
];
const suitesTo = { name: ROUTE_NAMES.suites };
</script>

<template>
  <PageContainer variant="detail">
    <PageHeader title="New suite" :breadcrumbs="breadcrumbs" />

    <ErrorBanner
      v-if="listError && !ready"
      title="Could not load suites"
      :detail="listError"
      hint='The form needs the suite list to check names and to offer "Copy of a suite". Check that the api service is running: docker compose ps api'
      retry-label="Retry"
      data-testid="new-suite-error"
      @retry="load"
    />

    <div
      v-else-if="!ready"
      class="flex w-420 flex-col gap-14"
      aria-busy="true"
      data-testid="new-suite-loading"
    >
      <div v-for="n in 3" :key="n" class="flex flex-col gap-6">
        <span class="h-8 w-90 animate-shimmer rounded-3 bg-surface-3" />
        <span class="h-30 w-full animate-shimmer rounded-4 bg-surface-3" />
      </div>
      <div class="flex gap-6">
        <span class="h-26 w-70 animate-shimmer rounded-4 bg-surface-3" />
        <span class="h-26 w-110 animate-shimmer rounded-4 bg-surface-3" />
        <span class="h-26 w-90 animate-shimmer rounded-4 bg-surface-3" />
      </div>
      <span class="h-30 w-80 animate-shimmer rounded-4 bg-surface-3" />
    </div>

    <form
      v-else
      class="flex w-640 max-w-full flex-col gap-18 rounded-6 border border-border bg-surface p-20"
      data-testid="new-suite-form"
      @submit.prevent="create"
    >
      <div class="flex flex-col gap-4">
        <label class="text-12 font-medium text-text-2" for="ns-name">Name</label>
        <input
          id="ns-name"
          v-model="name"
          class="input w-full font-mono text-12"
          placeholder="invoices-v2"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="
            problem?.kind === 'taken' || problem?.kind === 'invalid' ? 'true' : 'false'
          "
          aria-describedby="ns-name-msg ns-name-help"
          data-testid="suite-name"
        />
        <span
          v-if="problem?.kind === 'taken'"
          id="ns-name-msg"
          role="alert"
          class="text-12 leading-16 text-fail-text"
          data-testid="name-problem"
          ><code>{{ trimmed }}</code> is already used by
          <template v-if="problem.draft">the draft of a new suite</template
          ><code v-else>{{ problem.path }}</code
          >.</span
        >
        <span
          v-else-if="problem?.kind === 'invalid'"
          id="ns-name-msg"
          role="alert"
          class="text-12 leading-16 text-fail-text"
          data-testid="name-problem"
          >Use letters, digits, <code>.</code>, <code>_</code> and <code>-</code>, starting with a
          letter or digit.</span
        >
        <span id="ns-name-help" class="text-12 leading-16 text-text-3" data-testid="folder-line"
          >Folder: <code class="text-text-2">{{ folderLine(trimmed, trimmed !== '') }}</code> ·
          Fixed after the first save.</span
        >
      </div>

      <div class="flex w-200 flex-col gap-4">
        <label class="text-12 font-medium text-text-2" for="ns-label">Version label</label>
        <input
          id="ns-label"
          v-model="versionLabel"
          class="input font-mono text-12"
          :aria-invalid="labelEmpty ? 'true' : 'false'"
          data-testid="version-label"
        />
        <span class="w-600 max-w-[calc(100vw-80px)] text-12 leading-16 text-text-3"
          >Your own label. The platform numbers versions itself (v1, v2, …).</span
        >
      </div>

      <div class="flex flex-col gap-4">
        <label class="text-12 font-medium text-text-2" for="ns-desc"
          >Description <span class="font-normal text-text-3">optional</span></label
        >
        <textarea id="ns-desc" v-model="description" class="input" rows="2" />
      </div>

      <div class="flex flex-col gap-4">
        <span id="ns-from" class="text-12 font-medium text-text-2">Start from</span>
        <div
          class="inline-flex self-start overflow-hidden rounded-4 border border-border-strong"
          role="group"
          aria-labelledby="ns-from"
        >
          <button
            type="button"
            class="h-30 border-r border-border-strong px-12 text-text-2 aria-pressed:bg-accent-soft aria-pressed:font-medium aria-pressed:text-text"
            :aria-pressed="from === 'empty'"
            @click="from = 'empty'"
          >
            Empty
          </button>
          <button
            type="button"
            class="h-30 border-r border-border-strong px-12 text-text-2 aria-pressed:bg-accent-soft aria-pressed:font-medium aria-pressed:text-text"
            :aria-pressed="from === 'copy'"
            data-testid="from-copy"
            @click="from = 'copy'"
          >
            Copy of a suite
          </button>
          <button
            type="button"
            class="h-30 px-12 text-text-2"
            data-testid="from-zip"
            @click="zipOpen = true"
          >
            A .zip file
          </button>
        </div>
        <div v-if="from === 'copy'" class="mt-6 flex flex-col gap-4">
          <label class="text-12 font-medium text-text-2" for="ns-src">Suite to copy</label>
          <select
            id="ns-src"
            class="input w-360 max-w-full font-mono text-12"
            :value="source?.path ?? ''"
            data-testid="copy-source"
            @change="copyPath = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="row in sources" :key="row.path" :value="row.path">
              {{ sourceLabel(row) }}
            </option>
          </select>
          <span class="text-12 leading-16 text-text-3"
            >Every task is copied at its current version, with its files. The copy starts as a
            draft, so nothing is written until you save v1.</span
          >
        </div>
        <span v-else class="text-12 leading-16 text-text-3"
          >The suite opens as a draft with no tasks. Add them next.</span
        >
      </div>

      <div class="flex items-start gap-10 rounded-6 bg-surface-2 px-12 py-10">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.25"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          class="mt-2 flex-none text-text-3"
        >
          <path
            d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
          />
        </svg>
        <span class="text-12 leading-18 text-text-2"
          >Saved as files in <code class="text-text">{{ folderLine(trimmed, usable) }}</code> on
          this machine. Edit them here or on disk, and commit them with git like any other
          file.</span
        >
      </div>

      <ErrorBanner
        v-if="createError"
        title="The suite was not created"
        :detail="createError"
        compact
      />

      <div class="flex items-center gap-8 border-t border-border pt-16">
        <button
          type="submit"
          class="btn primary"
          :aria-disabled="blocked ? 'true' : undefined"
          :disabled="creating"
          data-testid="create-suite"
        >
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
        <RouterLink class="btn" :to="suitesTo">Cancel</RouterLink>
        <span
          class="text-12 leading-16"
          :class="hint.problem ? 'text-fail-text' : 'text-text-3'"
          data-testid="create-hint"
          >{{ hint.text }}</span
        >
      </div>
    </form>

    <ImportSuiteDialog v-model:open="zipOpen" />
  </PageContainer>
</template>

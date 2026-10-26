<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { errorMessage } from '@/api/client';
import type { DraftReview, DraftSaveResult, SaveStep } from '@/api/types/authoring';
import DraftChangeList from '@/components/authoring/save/DraftChangeList.vue';
import DraftWritesPanel from '@/components/authoring/save/DraftWritesPanel.vue';
import SavePanel, { type SavePhase } from '@/components/authoring/save/SavePanel.vue';
import PageContainer from '@/components/layout/PageContainer.vue';
import { hhmm } from '@/components/suites/authoringFormat';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import type { BreadcrumbItem } from '@/components/ui/types';
import { plural } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import { draftLocation } from './authoringRoutes';

/**
 * Review and save (SaveDraft board, SA.11; Flow E step 7): what the draft changes against
 * its base, each task row opening its TaskDiff; every file the save writes; the version
 * label; and the sticky panel that saves. Save sends the save-suite-draft job: the worker
 * stages the folder, loads it, runs the self-checks and only then moves it into ./suites,
 * so a failure leaves disk unchanged and the draft kept. A conflict found while saving goes
 * back to the draft, which shows it (SA.12).
 */
const props = defineProps<{ folder: string }>();

const store = useSuiteAuthoringStore();
const router = useRouter();

const review = ref<DraftReview | null>(null);
const loadError = ref<string | null>(null);
const versionLabel = ref('');
const phase = ref<SavePhase>('review');
const result = ref<DraftSaveResult | null>(null);
const failure = ref<{ step: SaveStep; message: string } | null>(null);
const saveError = ref<string | null>(null);

async function load(): Promise<void> {
  loadError.value = null;
  const folder = props.folder;
  try {
    const next = await store.loadReview(folder);
    if (folder !== props.folder) return;
    review.value = next;
    versionLabel.value = next.draft.versionLabel;
  } catch (err) {
    if (folder === props.folder) loadError.value = errorMessage(err);
  }
}
watch(
  () => props.folder,
  () => {
    review.value = null;
    phase.value = 'review';
    result.value = null;
    failure.value = null;
    void load();
  },
  { immediate: true },
);

const draft = computed(() => review.value?.draft ?? null);
const folderPath = computed(() => `${draft.value?.path ?? `./suites/${props.folder}`}/`);
const title = computed(() =>
  draft.value ? `Review and save as v${draft.value.nextVersion}` : 'Review and save',
);
const subline = computed(() => {
  const d = draft.value;
  if (!d) return '';
  const lead = d.base ? `Draft based on v${d.base.versionNumber}` : 'New suite · not saved yet';
  return `${lead} · ${plural(d.changes.length, 'change')} · saved ${hhmm(d.updatedAt)}`;
});
const draftTo = computed(() => draftLocation(props.folder));
const breadcrumbs = computed<BreadcrumbItem[]>(() => [
  { label: 'Suites', to: { name: ROUTE_NAMES.suites } },
  { label: props.folder, to: draftTo.value },
  { label: 'Review and save' },
]);

/** What stops Save before it is sent: a suite-level problem, or the folder moved on. */
const blockedReason = computed(() => {
  const d = draft.value;
  if (!d) return null;
  if (d.conflict) return `Combine the draft onto v${d.conflict.current.versionNumber} first.`;
  if (versionLabel.value.trim() === '') return 'Add a version label.';
  return d.problems[0]?.message ?? null;
});

function save(): void {
  if (blockedReason.value || !review.value) return;
  if (review.value.invalid.length > 0) phase.value = 'confirm';
  else void runSave();
}

async function runSave(): Promise<void> {
  const r = review.value;
  if (!r) return;
  phase.value = 'saving';
  saveError.value = null;
  const label = versionLabel.value.trim();
  try {
    const outcome = await store.save(props.folder, {
      ...(label !== r.draft.versionLabel ? { versionLabel: label } : {}),
      revision: r.draft.revision,
    });
    if (outcome.kind === 'saved') {
      result.value = outcome.result;
      phase.value = outcome.result.outcome === 'unchanged' ? 'nochanges' : 'created';
    } else if (outcome.kind === 'failed') {
      failure.value = { step: outcome.step, message: outcome.message };
      phase.value = 'notsaved';
    } else if (outcome.kind === 'no-worker') {
      phase.value = 'offline';
    } else {
      await router.push(draftTo.value);
    }
  } catch (err) {
    saveError.value = errorMessage(err);
    phase.value = 'review';
  }
}

const suiteTo = computed(() =>
  result.value ? { name: ROUTE_NAMES.suite, params: { id: result.value.suite.suiteId } } : null,
);
const experimentTo = computed(() =>
  result.value
    ? { name: ROUTE_NAMES.experimentNew, query: { suite: result.value.suite.suiteId } }
    : null,
);
</script>

<template>
  <PageContainer variant="detail">
    <PageHeader :title="title" :breadcrumbs="breadcrumbs">
      <template #meta>
        <p v-if="subline" class="text-text-2" data-testid="save-subline">{{ subline }}</p>
      </template>
    </PageHeader>

    <ErrorBanner
      v-if="loadError"
      title="Could not load the review of the draft"
      :detail="loadError"
      :hint="`Nothing was written to ${folderPath}. Your draft is kept.`"
      retry-label="Retry"
      data-testid="review-error"
      @retry="load"
    />

    <div
      v-else-if="!review"
      class="flex flex-wrap items-start gap-16"
      aria-busy="true"
      data-testid="review-loading"
    >
      <div class="flex min-w-0 flex-[999_1_760px] flex-col gap-16">
        <div class="rounded-6 border border-border bg-surface">
          <div
            v-for="w in [160, 120, 90]"
            :key="w"
            class="flex items-center gap-10 border-b border-border px-16 py-10 last:border-b-0"
          >
            <span class="h-14 w-50 animate-shimmer rounded-3 bg-surface-3" />
            <span class="h-10 w-110 animate-shimmer rounded-3 bg-surface-3" />
            <span
              class="h-10 animate-shimmer rounded-3 bg-surface-3"
              :style="{ width: `${w}px` }"
            />
          </div>
        </div>
        <div class="flex flex-col gap-8 rounded-6 border border-border bg-surface p-16">
          <span class="h-12 w-140 animate-shimmer rounded-3 bg-surface-3" />
          <span class="h-10 w-[90%] animate-shimmer rounded-3 bg-surface-3" />
          <span class="h-10 w-[80%] animate-shimmer rounded-3 bg-surface-3" />
        </div>
      </div>
      <div
        class="flex flex-[0_0_360px] flex-col gap-9 rounded-6 border border-border bg-surface p-16"
      >
        <span class="h-12 w-110 animate-shimmer rounded-3 bg-surface-3" />
        <span class="h-10 w-[80%] animate-shimmer rounded-3 bg-surface-3" />
        <span class="h-10 w-[70%] animate-shimmer rounded-3 bg-surface-3" />
        <span class="h-30 w-full animate-shimmer rounded-4 bg-surface-3" />
      </div>
    </div>

    <div v-else class="flex flex-wrap items-start gap-16">
      <div class="flex min-w-0 flex-[999_1_760px] flex-col gap-16">
        <div
          v-if="review.draft.conflict"
          role="status"
          class="flex flex-wrap items-center gap-x-14 gap-y-8 rounded-6 border border-ung bg-ung-soft px-14 py-10"
          data-testid="save-conflict"
        >
          <span class="min-w-280 flex-1"
            ><b class="text-ung-text"
              ><code>{{ review.draft.path }}</code> changed on disk after this draft began.</b
            >
            <span class="text-text-2">
              Combine the draft onto v{{ review.draft.conflict.current.versionNumber }} before
              saving.</span
            ></span
          >
          <RouterLink class="btn sm" :to="draftTo">Back to the draft</RouterLink>
        </div>
        <DraftChangeList
          :folder="folder"
          :changes="review.changes"
          :base-version="review.draft.base?.versionNumber ?? null"
        />
        <DraftWritesPanel :writes="review.writes" :folder-path="folderPath" />
        <section
          class="grid grid-cols-[200px_minmax(0,1fr)] gap-20 rounded-6 border border-border bg-surface px-16 py-14 max-md:grid-cols-1"
          aria-labelledby="save-label"
        >
          <div>
            <label id="save-label" for="save-version-label" class="text-15 font-semibold"
              >Version label</label
            >
            <p class="mt-2 text-12 text-text-3">
              <template v-if="review.draft.base"
                >Current label {{ review.draft.base.versionLabel ?? '–' }}</template
              >
              <template v-else>The label of v1</template>
            </p>
          </div>
          <div class="flex flex-col gap-4">
            <input
              id="save-version-label"
              v-model="versionLabel"
              class="input w-160 font-mono text-12"
              :aria-invalid="versionLabel.trim() === '' ? 'true' : 'false'"
              :disabled="phase === 'saving'"
              data-testid="save-version-label"
            />
            <span class="text-12 text-text-3"
              >Change it if you track your own versions. The platform numbers versions itself: this
              save creates v{{ review.draft.nextVersion }}.</span
            >
          </div>
        </section>
      </div>

      <aside class="sticky top-16 flex flex-[0_0_360px] flex-col gap-12" aria-label="Save">
        <ErrorBanner v-if="saveError" title="The draft was not saved" :detail="saveError" compact />
        <SavePanel
          :phase="phase"
          :review="review"
          :folder-path="folderPath"
          :progress="store.saveProgress"
          :result="result"
          :failure="failure"
          :suite-to="suiteTo"
          :experiment-to="experimentTo"
          :draft-to="draftTo"
          :blocked-reason="blockedReason"
          @save="save"
          @confirm="runSave"
          @keep-editing="phase = 'review'"
          @retry="runSave"
        />
      </aside>
    </div>
  </PageContainer>
</template>

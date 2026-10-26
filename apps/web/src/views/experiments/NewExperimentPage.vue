<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { watchDebounced } from '@vueuse/core';
import { errorMessage } from '@/api/client';
import type { NewExperimentDraft } from '@/api/types/experiments';
import PageContainer from '@/components/layout/PageContainer.vue';
import ConfigurationsSection from '@/components/new-experiment/ConfigurationsSection.vue';
import DuplicateNotice from '@/components/new-experiment/DuplicateNotice.vue';
import ExperimentSummaryPanel from '@/components/new-experiment/ExperimentSummaryPanel.vue';
import FormSection from '@/components/new-experiment/FormSection.vue';
import LimitsSection from '@/components/new-experiment/LimitsSection.vue';
import NewExperimentSkeleton from '@/components/new-experiment/NewExperimentSkeleton.vue';
import RepetitionsSection from '@/components/new-experiment/RepetitionsSection.vue';
import SuiteTasksSection from '@/components/new-experiment/SuiteTasksSection.vue';
import {
  launchBlockers,
  launchFailure,
  type LaunchFailure,
  type ProviderSnapshot,
} from '@/components/new-experiment/launchReadiness';
import {
  provideNewExperimentForm,
  useNewExperimentForm,
} from '@/components/new-experiment/useNewExperimentForm';
import BaseInput from '@/components/ui/BaseInput.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import TextArea from '@/components/ui/TextArea.vue';
import { ROUTE_NAMES } from '@/router';
import { useExperimentsStore } from '@/stores/experiments';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';

/**
 * New experiment (NewExperiment and NewExperimentStates boards, UI_FLOWS 11): one long form,
 * five numbered sections, and the sticky summary panel that sizes and prices the experiment as
 * it is edited (GET /experiments/estimate) and launches it (POST /experiments, then the
 * Overview). Launch is disabled with the first unmet requirement, or with what blocks the
 * chosen configurations (a provider, an MCP variable that is not set, the worker, the sandbox)
 * and its fix. A refused launch
 * shows the API's reason in the panel and the form keeps its values; a configuration that
 * changed since the form loaded is reloaded, so the comparison shows what launch would freeze.
 *
 * /experiments/new?from=<id> is Duplicate: the form prefilled on the suite's current version,
 * with what changed and what was left out. &repetitions=<n> then sets the repetitions (the
 * Comparison's "Duplicate with 5 repetitions"). ?suite=<suiteId> starts on that suite version
 * with all its valid tasks (Review and save's "New experiment on v7", Flow E).
 */
const props = defineProps<{ duplicateOf?: string; repetitions?: number; suite?: string }>();

const router = useRouter();
const store = useExperimentsStore();
const providers = useProvidersStore();
const system = useSystemStore();

const form = useNewExperimentForm(toRef(store, 'options'));
provideNewExperimentForm(form);

// ── loading ───────────────────────────────────────────────────────────────
const loading = ref(true);
/** The last launch's refusal or failure, shown in the panel until the next launch. */
const failure = ref<LaunchFailure | null>(null);
const draft = ref<NewExperimentDraft | null>(null);
const sourceName = ref('');
const draftError = ref<string | null>(null);

async function loadDraft(id: string): Promise<void> {
  try {
    const next = await store.loadDuplicate(id);
    draft.value = next;
    sourceName.value = next.values.name;
    draftError.value = null;
    if (store.options) form.applyDraft(next, store.options);
  } catch (err) {
    draftError.value = errorMessage(err);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  draft.value = null;
  draftError.value = null;
  failure.value = null;
  const options = await store.loadOptions();
  if (options) form.reset(options);
  if (options && props.suite && options.suites.some((s) => s.suiteId === props.suite))
    form.selectSuite(props.suite);
  loading.value = false;
  if (options && props.duplicateOf) await loadDraft(props.duplicateOf);
  if (options && props.repetitions !== undefined) form.state.repetitions = props.repetitions;
}
watch(
  () => [props.duplicateOf, props.repetitions, props.suite],
  () => void load(),
  { immediate: true },
);

// ── estimate ──────────────────────────────────────────────────────────────
watchDebounced(form.estimateQuery, (query) => void store.refreshEstimate(query), {
  debounce: 250,
  immediate: true,
});
onBeforeUnmount(() => store.resetNewExperiment());

// ── what blocks the launch ────────────────────────────────────────────────
const providerSnapshot = computed<ProviderSnapshot>(() => ({
  loaded: providers.loaded,
  providers: providers.providers,
  nousStatus: providers.nousStatus,
  nousConnected: providers.nousConnected,
}));
const noWorker = computed(() =>
  system.loaded ? system.noWorker : store.options?.workerCount === 0,
);
const blockers = computed(() =>
  launchBlockers(
    providerSnapshot.value,
    { noWorker: noWorker.value, sandboxProven: system.sandboxProven },
    form.ordered.value.map((c) => ({
      name: c.name,
      provider: c.provider,
      missingSecrets: c.missingSecrets,
    })),
  ),
);

/**
 * Check again (unset MCP variables): nothing streams which variables the worker and egress
 * have, so the configurations are reloaded; the chosen versions stay chosen.
 */
async function recheckSecrets(): Promise<void> {
  await store.loadOptions();
}

// ── launch ────────────────────────────────────────────────────────────────
/** A refusal that a blocker now says too (Nous Portal, unset MCP variables) is not repeated. */
const shownFailure = computed(() => {
  const kind = failure.value?.kind;
  if (kind === 'provider' && blockers.value.some((b) => b.provider === 'nous')) return null;
  if (kind === 'secrets' && blockers.value.some((b) => b.fix === 'secrets')) return null;
  return failure.value;
});

/**
 * From Launch until the Overview shows: the POST has answered before the Overview's page has
 * loaded, and a second Launch in between would create a second experiment.
 */
const submitting = ref(false);
/** The experiment this form launched: it never launches again. */
const launchedId = ref<string | null>(null);
const busy = computed(() => store.launching || submitting.value);

async function launch(): Promise<void> {
  form.nameTouched.value = true;
  const input = form.launchInput();
  if (!input || blockers.value.length > 0 || busy.value || launchedId.value) return;
  failure.value = null;
  submitting.value = true;
  try {
    const id = await store.launch(input);
    launchedId.value = id;
    await router.push({ name: ROUTE_NAMES.experimentOverview, params: { id } });
  } catch (err) {
    // Launched already (the Overview failed to load): the form stays locked.
    if (launchedId.value) return;
    submitting.value = false;
    failure.value = launchFailure(err);
    if (failure.value.kind === 'conflict') {
      const previous = store.options;
      const next = await store.loadOptions();
      if (previous && next) form.remap(previous, next);
    }
    // The configurations then name the variables, and their blocker replaces the refusal.
    if (failure.value.kind === 'secrets') await store.loadOptions();
  }
}

// A refusal is about what was chosen then: editing the choice clears it. A conflict's reload
// changes the choice itself, so its "review the comparison" stays until the next launch.
watch(
  () =>
    [
      form.state.suiteId,
      form.selectedTasks.value.join(),
      form.ordered.value.map((c) => c.versionId).join(),
    ].join('|'),
  () => {
    if (failure.value && failure.value.kind !== 'conflict') failure.value = null;
  },
);

/** Connect (or Reconnect) Nous Portal; "Launch now" on Connected launches, nothing else does. */
function connect(): void {
  void providers.connect(
    'new-experiment',
    (action) => {
      if (action === 'launch') void launch();
    },
    { experimentName: form.state.name.trim() || null },
  );
}

// ── section 1 ─────────────────────────────────────────────────────────────
const text = (key: 'name' | 'description') =>
  computed({
    get: () => form.state[key],
    set: (value: string | number | null) => (form.state[key] = value === null ? '' : String(value)),
  });
const name = text('name');
const description = text('description');
const nameHelp =
  'Shown in the experiment list. It cannot be changed after launch, and neither can the snapshot.';

const breadcrumbs = [
  { label: 'Experiments', to: { name: ROUTE_NAMES.experiments } },
  { label: 'New experiment' },
];
</script>

<template>
  <PageContainer variant="detail">
    <PageHeader title="New experiment" :breadcrumbs="breadcrumbs" />

    <NewExperimentSkeleton v-if="loading" />

    <ErrorBanner
      v-else-if="store.optionsError && !store.options"
      title="Could not load suites and configurations"
      :detail="store.optionsError"
      hint="Nothing is lost: the form has not been filled yet. The configurations request is retried together with it."
      retry-label="Retry"
      @retry="load()"
    />

    <div v-else class="flex flex-wrap items-start gap-20">
      <form
        class="flex min-w-0 flex-[999_1_640px] flex-col gap-16"
        novalidate
        @submit.prevent="launch"
      >
        <fieldset :disabled="busy" class="m-0 flex min-w-0 flex-col gap-16 border-0 p-0">
          <legend class="sr-only">New experiment</legend>
          <ErrorBanner
            v-if="draftError"
            title="Could not load the experiment to duplicate"
            :detail="draftError"
            hint="The form below starts empty instead."
            retry-label="Retry"
            @retry="duplicateOf && loadDraft(duplicateOf)"
          />
          <DuplicateNotice v-if="draft" :draft="draft" :source-name="sourceName" />

          <FormSection :number="1" title="Name and description">
            <div class="grid grid-cols-1 gap-12">
              <BaseInput
                id="ne-name"
                v-model="name"
                label="Name"
                required
                :help="nameHelp"
                :error="form.nameError.value"
                @blur="form.nameTouched.value = true"
              />
              <TextArea
                id="ne-desc"
                v-model="description"
                label="Description"
                :rows="2"
                :error="form.descriptionError.value"
              />
            </div>
          </FormSection>

          <SuiteTasksSection
            :changed-since="draft ? draft.changes.suiteVersionFrom : null"
            :changed-tasks="draft?.changes.changedTasks ?? []"
          />
          <ConfigurationsSection :providers="providerSnapshot" :no-worker="noWorker" />
          <RepetitionsSection />
          <LimitsSection />
        </fieldset>
      </form>

      <div
        class="sticky top-16 max-w-380 min-w-0 flex-[1_1_320px] self-start max-lg:static max-lg:max-w-none"
      >
        <!-- A panel taller than the window scrolls inside, so Launch stays reachable. -->
        <ExperimentSummaryPanel
          class="lg:max-h-[calc(100vh-32px)] lg:overflow-y-auto"
          :task-count="form.taskCount.value"
          :config-count="form.configCount.value"
          :repetitions="form.state.repetitions"
          :concurrency="form.state.concurrency"
          :estimate="form.estimateQuery.value ? store.estimate : null"
          :estimate-loading="store.estimateLoading"
          :estimate-error="store.estimateError"
          :suite-name="form.suite.value?.name ?? null"
          :per-run-tokens="form.perRunTokens.value"
          :without-history="form.withoutHistory.value"
          :price-table="store.options?.priceTable ?? []"
          :models="form.ordered.value.map((c) => c.model)"
          :spend-ceiling-usd="form.spendCeilingError.value ? null : form.spendCeilingUsd.value"
          :invalid-reason="form.invalidReason.value"
          :blockers="blockers"
          :busy="busy"
          :failure="shownFailure"
          @launch="launch"
          @connect="connect"
          @recheck="recheckSecrets"
        />
      </div>
    </div>
  </PageContainer>
</template>

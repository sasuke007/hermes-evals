<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { SAMPLE_EXPERIMENT } from '@hermes-evals/shared';
import { launchFailure, type LaunchFailure } from '@/components/new-experiment/launchReadiness';
import { ROUTE_NAMES } from '@/router';
import { useExperimentsStore } from '@/stores/experiments';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import { sampleExperimentPlan } from './sampleExperiment';

/**
 * "Run a sample experiment" (Phase 8 G4): launches invoices-v1, its baseline against its
 * with-skill arm on the scripted mock model, every valid task, 2 repetitions, through the
 * normal launch (POST /experiments), then opens the new experiment. Built from New
 * experiment's options, which the page loads; disabled with its reason while the suite or a
 * seeded configuration is missing, or while nothing could launch (no worker, the sandbox).
 *
 *   button  the empty Experiments page: a button with what it runs under it
 *   link    New experiment: a sentence under the title, with the action as a link
 */
withDefaults(
  defineProps<{
    variant?: 'button' | 'link';
    /** button: centred in a centred empty state, or from the start (the setup card). */
    align?: 'center' | 'start';
  }>(),
  { variant: 'button', align: 'center' },
);

const router = useRouter();
const store = useExperimentsStore();
const providers = useProvidersStore();
const system = useSystemStore();

const plan = computed(() =>
  sampleExperimentPlan(
    store.options,
    {
      loaded: providers.loaded,
      providers: providers.providers,
      nousStatus: providers.nousStatus,
      nousConnected: providers.nousConnected,
    },
    {
      // As New experiment reads it: the summary stream once it has spoken, else the options.
      noWorker: system.loaded ? system.noWorker : store.options?.workerCount === 0,
      sandboxProven: system.sandboxProven,
    },
  ),
);
/** Options that failed to load say so instead of "Loading". */
const reason = computed(() =>
  !store.options && store.optionsError
    ? `Could not load the suites and configurations: ${store.optionsError}`
    : plan.value.reason,
);
const fix = computed(() => {
  if (plan.value.fix === 'suites')
    return { label: 'Open Suites', to: { name: ROUTE_NAMES.suites } };
  if (plan.value.fix === 'system')
    return { label: 'Open System', to: { name: ROUTE_NAMES.system } };
  return { label: null, to: null };
});

/** From the click until the new experiment opens: a second click would launch it twice. */
const busy = ref(false);
const failure = ref<LaunchFailure | null>(null);

async function run(): Promise<void> {
  const input = plan.value.input;
  if (!input || busy.value) return;
  busy.value = true;
  failure.value = null;
  try {
    const id = await store.launch(input);
    await router.push({ name: ROUTE_NAMES.experimentOverview, params: { id } });
  } catch (err) {
    busy.value = false;
    failure.value = launchFailure(err);
    // A configuration changed since, or the seed was still running: read them again.
    void store.loadOptions();
  }
}

const what = `${SAMPLE_EXPERIMENT.suite}, its baseline against its with-skill arm on the scripted mock model: every valid task, ${SAMPLE_EXPERIMENT.repetitions} repetitions.`;
const reasonId = `sample-reason-${useId()}`;
</script>

<template>
  <div
    v-if="variant === 'button'"
    class="flex flex-col gap-6"
    :class="align === 'center' ? 'items-center text-center' : 'items-start'"
    data-testid="sample-experiment"
    :data-state="reason === null ? 'ready' : 'blocked'"
  >
    <button
      type="button"
      class="btn"
      :disabled="busy || plan.input === null"
      :title="reason ?? undefined"
      :aria-describedby="reason === null ? undefined : reasonId"
      :aria-busy="busy || undefined"
      data-testid="sample-experiment-run"
      @click="run"
    >
      {{ busy ? 'Launching…' : 'Run a sample experiment' }}
    </button>
    <span class="text-12 text-text-3">{{ what }}</span>
    <span
      v-if="reason !== null"
      :id="reasonId"
      class="max-w-520 text-12 text-text-3"
      data-testid="sample-experiment-reason"
      >{{ reason
      }}<template v-if="fix.to"
        >{{ ' ' }}<RouterLink :to="fix.to">{{ fix.label }}</RouterLink></template
      ></span
    >
    <p
      v-if="failure"
      role="alert"
      class="flex flex-col gap-2 text-12 text-fail-text"
      data-testid="sample-experiment-failure"
    >
      <b>{{ failure.title }}</b>
      <code class="wrap-anywhere text-text-2">{{ failure.message }}</code>
    </p>
  </div>
  <p
    v-else
    class="text-12 leading-18 text-text-3"
    data-testid="sample-experiment"
    :data-state="reason === null ? 'ready' : 'blocked'"
  >
    New here?
    <button
      type="button"
      class="linkbtn text-12 disabled:cursor-default disabled:text-text-3 disabled:no-underline"
      :disabled="busy || plan.input === null"
      :title="reason ?? undefined"
      :aria-describedby="reason === null ? undefined : reasonId"
      :aria-busy="busy || undefined"
      data-testid="sample-experiment-run"
      @click="run"
    >
      {{ busy ? 'Launching the sample experiment…' : 'Run a sample experiment' }}</button
    ><template v-if="reason === null">: {{ what }}</template
    ><span v-else :id="reasonId" data-testid="sample-experiment-reason"
      >. {{ reason
      }}<template v-if="fix.to"
        >{{ ' ' }}<RouterLink :to="fix.to">{{ fix.label }}</RouterLink></template
      ></span
    >
    <span
      v-if="failure"
      role="alert"
      class="block text-fail-text"
      data-testid="sample-experiment-failure"
      >{{ failure.title }}: <code class="wrap-anywhere">{{ failure.message }}</code></span
    >
  </p>
</template>

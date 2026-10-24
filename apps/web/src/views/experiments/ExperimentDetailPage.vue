<script setup lang="ts">
/**
 * Experiment detail: the header, the tab row (Overview · Comparison · Runs)
 * and the run inspector drawer. Placeholder: the page builder replaces the
 * header and keeps the routing contract below.
 *
 * The drawer shows whenever the route names a run: `experiment-run`
 * (/experiments/:id/runs/:runId, opened from the Runs tab) or `?run=<runId>`
 * on any tab (opened from the comparison grid or the Overview feed), so the
 * tab behind keeps its state.
 */
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter, type LocationQuery } from 'vue-router';
import RunInspectorDrawer from '@/components/inspector/RunInspectorDrawer.vue';
import { inspectedRunId, ROUTE_NAMES } from '@/router';

const props = defineProps<{ experimentId: string }>();

const route = useRoute();
const router = useRouter();

const runId = computed(() => inspectedRunId(route));

const tabs = computed(() => [
  { label: 'Overview', name: ROUTE_NAMES.experimentOverview, exact: true },
  { label: 'Comparison', name: ROUTE_NAMES.experimentComparison, exact: false },
  { label: 'Runs', name: ROUTE_NAMES.experimentRuns, exact: false },
]);

function withoutRun(query: LocationQuery): LocationQuery {
  const rest = { ...query };
  delete rest.run;
  return rest;
}

/** Opens a run in the drawer the same way it was opened (route param or ?run=). */
function openRun(id: string): void {
  if (route.name === ROUTE_NAMES.experimentRun || route.name === ROUTE_NAMES.experimentRuns) {
    void router.push({
      name: ROUTE_NAMES.experimentRun,
      params: { id: props.experimentId, runId: id },
      query: withoutRun(route.query),
    });
  } else {
    void router.push({ query: { ...route.query, run: id } });
  }
}

function closeInspector(): void {
  if (route.name === ROUTE_NAMES.experimentRun) {
    void router.push({
      name: ROUTE_NAMES.experimentRuns,
      params: { id: props.experimentId },
      query: route.query,
    });
  } else {
    void router.push({ query: withoutRun(route.query) });
  }
}
</script>

<template>
  <main class="page">
    <h1 class="page-title">Experiment</h1>
    <p class="t2">The experiment header is being built.</p>
    <nav class="tabs" aria-label="Experiment">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.name"
        v-slot="{ href, navigate, isActive, isExactActive }"
        :to="{ name: tab.name, params: { id: experimentId } }"
        custom
      >
        <a
          class="tab"
          :href="href"
          :aria-current="(tab.exact ? isExactActive : isActive) ? 'page' : undefined"
          @click="navigate"
          >{{ tab.label }}</a
        >
      </RouterLink>
    </nav>
    <RouterView />
    <RunInspectorDrawer
      v-if="runId"
      :run-id="runId"
      :experiment-id="experimentId"
      @close="closeInspector"
      @navigate="openRun"
    />
  </main>
</template>

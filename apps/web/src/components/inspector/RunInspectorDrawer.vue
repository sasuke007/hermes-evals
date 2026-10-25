<script setup lang="ts">
/**
 * Run inspector drawer (plan 12.2 item 8; RunInspector, RunInspectorStates, RunInspectorMcp,
 * RunInspectorSkill, RunInspectorDark): a right-hand drawer at 75% of the viewport (min
 * 960px) over the page that opened it, route-backed, with five sections: Outcome, Timeline,
 * Final response, Artifacts, Launch record.
 *
 * Props: runId (the run shown), experimentId, siblings (ordered run ids of the calling view,
 * for Prev / Next with K / J; they become the inspector store's order, named after the tab
 * behind: "Comparison · grid order · run 15 of 120"; without any, the experiment's runs in
 * their default order), returnFocusTo (focus on close when the opener left the page, such as
 * a feed row that moved on). Events: close (Esc, scrim, close button), navigate(runId) (Prev,
 * Next, the A/B jump).
 *
 * Live: while the run executes, its events are polled every second and patched in place
 * (the list follows the newest); while it is unsettled (queued, running, scoring, a re-score
 * in flight) the detail is reloaded every 5 s.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useEventListener } from '@vueuse/core';
import BaseDrawer from '@/components/ui/BaseDrawer.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { usePolling } from '@/composables/usePolling';
import { ROUTE_NAMES } from '@/router';
import { isUnsettled, useInspectorStore, type RunPosition } from '@/stores/inspector';
import { useProvidersStore } from '@/stores/providers';
import ArtifactsSection from './ArtifactsSection.vue';
import FinalResponseSection from './FinalResponseSection.vue';
import InspectorHeader from './InspectorHeader.vue';
import InspectorNav from './InspectorNav.vue';
import LaunchRecordSection from './LaunchRecordSection.vue';
import OutcomeSection from './OutcomeSection.vue';
import TimelineSection from './TimelineSection.vue';

const props = defineProps<{
  runId: string;
  experimentId: string;
  siblings?: string[];
  /** Where focus goes on close when the element that opened the drawer is gone. */
  returnFocusTo?: (() => HTMLElement | null) | null;
}>();
const emit = defineEmits<{ close: []; navigate: [runId: string] }>();

/** Live events are polled this often (the API's own advice), the detail of an unsettled run less. */
const EVENTS_POLL_MS = 1_000;
const DETAIL_POLL_MS = 5_000;

const store = useInspectorStore();
const providers = useProvidersStore();
const route = useRoute();

const detail = computed(() => store.runs[props.runId] ?? null);
const error = computed(() => store.errors[props.runId] ?? null);

watch(
  () => props.runId,
  (id) => void store.load(id, { quiet: !!store.runs[id] }),
  { immediate: true },
);

// ── where the run sits: the caller's order ─────────────────────────────────
const source = computed(() => {
  const name = route.name;
  if (name === ROUTE_NAMES.experimentComparison) return 'Comparison';
  if (name === ROUTE_NAMES.experimentOverview) return 'Overview';
  return 'Runs';
});
/** How each page orders the runs it opens, as the header's position line names it. */
const ORDER_OF: Record<string, string> = {
  Comparison: 'grid order',
  Runs: 'table order',
  Overview: 'live feed',
};

// The siblings the page passed become the store's order; without any, the experiment's runs.
watch(
  () => [props.siblings, source.value] as const,
  ([ids, from]) => {
    if (ids?.length) {
      store.setOrder({
        experimentId: props.experimentId,
        source: from,
        order: ORDER_OF[from] ?? 'list order',
        ids: [...ids],
        note: from === 'Overview' ? 'opened from the feed' : null,
      });
    } else {
      void store.ensureOrder(props.experimentId, from);
    }
  },
  { immediate: true },
);

const neighbours = computed(() => store.neighbours(props.runId));
const position = computed<RunPosition | null>(() => store.positionOf(props.runId));

/** Prev or Next (K or J): out of any A/B jump, back to the list's own positions. */
function go(runId: string | null): void {
  if (!runId || runId === props.runId) return;
  store.clearJump();
  emit('navigate', runId);
}

function jump(target: string): void {
  if (!detail.value || target === props.runId) return;
  store.recordJump(props.runId, target, detail.value.configuration.name);
  emit('navigate', target);
}

// J / K anywhere in the drawer, unless typing or another overlay is on top.
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}
useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTyping(event.target) || providers.dialogOpen) return;
  const key = event.key.toLowerCase();
  if (key === 'j') go(neighbours.value.next);
  else if (key === 'k') go(neighbours.value.prev);
  else return;
  event.preventDefault();
});

// ── live ─────────────────────────────────────────────────────────────────────
const now = ref(Date.now());
usePolling(
  () => store.refreshEvents(props.runId),
  EVENTS_POLL_MS,
  () => !!detail.value?.timeline.live,
);
usePolling(
  () => store.load(props.runId, { quiet: true }),
  DETAIL_POLL_MS,
  () => !!detail.value && isUnsettled(detail.value),
);
usePolling(
  () => {
    now.value = Date.now();
  },
  1_000,
  () => detail.value?.status === 'running',
);

// ── sections ─────────────────────────────────────────────────────────────────
const sectionId = (key: string): string => `ri-${key}`;
const timeline = ref<InstanceType<typeof TimelineSection> | null>(null);
const launchRecord = ref<InstanceType<typeof LaunchRecordSection> | null>(null);

/** The header's section links: the launch record is collapsed, so its link opens it first. */
async function jumpToSection(key: string): Promise<void> {
  if (key === 'launch' && launchRecord.value) {
    launchRecord.value.open();
    await nextTick();
  }
  scrollToSection(key);
}

function scrollToSection(key: string): void {
  const el = document.getElementById(sectionId(key));
  const pane = el?.closest<HTMLElement>('[role="dialog"]');
  if (!el || !pane) return;
  const header = pane.querySelector('header');
  const offset = (header?.offsetHeight ?? 0) + 12;
  const delta = el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  pane.scrollTop += delta - offset;
}

async function seek(seq: number): Promise<void> {
  scrollToSection('timeline');
  await timeline.value?.seek(seq);
  await nextTick();
  scrollToSection('timeline');
}

// ── focus stays inside ───────────────────────────────────────────────────────
// The header is redrawn for each run (the A/B jump, J / K) and a control can disappear under
// the user (Cancel run done): focus must not drop to the page behind the modal. The control
// that had it is found again by its data-testid; while the next run loads, the drawer itself
// holds focus, and gets the control back once it is drawn.
const drawer = ref<InstanceType<typeof BaseDrawer> | null>(null);
let lastFocused: string | null = null;
let pendingFocus: string | null = null;

function onFocusIn(event: FocusEvent): void {
  const target = event.target;
  if (target instanceof HTMLElement && target !== drawer.value?.panel) {
    lastFocused = target.getAttribute('data-testid');
    pendingFocus = null;
  }
}

function keepFocus(): void {
  const panel = drawer.value?.panel;
  if (!panel) return;
  const active = document.activeElement;
  const lost = !active || active === document.body || !panel.contains(active);
  if (!lost && !(active === panel && pendingFocus)) return;
  const id = pendingFocus ?? lastFocused;
  const again = id ? panel.querySelector<HTMLElement>(`[data-testid="${id}"]`) : null;
  if (again && !again.matches(':disabled')) {
    again.focus();
  } else if (id && !detail.value) {
    pendingFocus = id;
    panel.focus();
  } else {
    pendingFocus = null;
    void drawer.value?.focusStart();
  }
}

watch(
  () => [props.runId, detail.value?.id ?? null, detail.value?.status ?? null],
  () => keepFocus(),
  { flush: 'post' },
);
</script>

<template>
  <BaseDrawer
    ref="drawer"
    title-id="ri-title"
    data-testid="run-inspector"
    :return-focus-fallback="returnFocusTo ?? null"
    @close="emit('close')"
    @focusin="onFocusIn"
  >
    <template #header>
      <InspectorNav
        :run-id="runId"
        :position="position"
        :prev="neighbours.prev"
        :next="neighbours.next"
        @close="emit('close')"
        @navigate="go"
      />
      <InspectorHeader
        v-if="detail"
        :key="detail.id"
        :detail="detail"
        :loaded-at="store.loadedAt[runId] ?? now"
        :now="now"
        @jump="jump"
        @section="jumpToSection"
      />
      <div
        v-else-if="!error"
        class="flex flex-col gap-10"
        aria-busy="true"
        aria-label="Loading this run"
        data-testid="inspector-loading"
      >
        <h1 id="ri-title" class="sr-only">Run {{ runId }}</h1>
        <div class="flex items-center gap-8" aria-hidden="true">
          <span class="block h-10 w-160 animate-shimmer rounded-3 bg-surface-3" />
          <span class="block h-10 w-90 animate-shimmer rounded-3 bg-surface-3" />
          <span class="block h-10 w-80 animate-shimmer rounded-3 bg-surface-3" />
          <span class="block h-20 w-60 animate-shimmer rounded-3 bg-surface-3" />
        </div>
      </div>
      <h1 v-else id="ri-title" class="font-mono text-20 font-semibold">{{ runId }}</h1>
    </template>

    <template v-if="detail">
      <OutcomeSection :detail="detail" :section-id="sectionId('outcome')" @seek="seek" />
      <TimelineSection ref="timeline" :detail="detail" :section-id="sectionId('timeline')" />
      <FinalResponseSection :detail="detail" :section-id="sectionId('final')" />
      <ArtifactsSection :detail="detail" :section-id="sectionId('artifacts')" />
      <LaunchRecordSection
        ref="launchRecord"
        :record="detail.launchRecord"
        :status="detail.status"
        :section-id="sectionId('launch')"
      />
    </template>
    <ErrorBanner
      v-else-if="error"
      title="Could not load this run"
      :detail="error"
      hint="Only the drawer failed. Prev and next still work; Esc closes it."
      retry-label="Retry"
      data-testid="inspector-error"
      @retry="store.load(runId)"
    />
    <div v-else class="flex flex-col gap-10" aria-hidden="true">
      <span class="block h-44 w-full animate-shimmer rounded-3 bg-surface-3" />
      <div v-for="w in [260, 200, 300]" :key="w" class="flex items-center gap-8">
        <span class="block h-10 w-56 animate-shimmer rounded-3 bg-surface-3" />
        <span class="block size-14 animate-shimmer rounded-3 bg-surface-3" />
        <span
          class="block h-10 animate-shimmer rounded-3 bg-surface-3"
          :style="{ width: `${w}px` }"
        />
      </div>
    </div>
  </BaseDrawer>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { RunDetail } from '@/api/types/runs';
import { formatCount } from '@/lib/format';
import EventTimeline from './EventTimeline.vue';
import SectionHeading from './SectionHeading.vue';
import TimelineScrubber from './TimelineScrubber.vue';
import { defaultOpenSeq, timelineCounts, timelineLegend } from './inspectorFormat';

/**
 * Section 2, Timeline (RunInspector; RunInspectorStates): the count line with Expand all,
 * the scrubber, the event list and the legend. The first error (else the first tool call)
 * opens by default. A live run's list grows as events arrive. After an execution error the
 * section starts folded to one line ("23 events before the timeout; the last one is still
 * open") with Show timeline, because the Outcome's banner and stderr come first.
 *
 * Exposes seek(seq): unfold, scroll the list to the event and open it (the scrubber and the
 * Outcome's evidence links use it).
 */
const props = defineProps<{ detail: RunDetail; sectionId: string }>();

const events = computed(() => props.detail.timeline.events);
const live = computed(() => props.detail.timeline.live);
const open = ref(new Set<number>());
const folded = ref(false);
const viewport = ref<{ first: number; last: number } | null>(null);
const list = ref<InstanceType<typeof EventTimeline> | null>(null);

// A new run or attempt: back to the default rows.
watch(
  () => `${props.detail.id}:${props.detail.shownAttempt}`,
  () => {
    const seq = live.value ? null : defaultOpenSeq(events.value);
    open.value = new Set(seq === null ? [] : [seq]);
    folded.value = props.detail.status === 'execution_error' && events.value.length > 0;
    viewport.value = null;
  },
  { immediate: true },
);

const allOpen = computed(
  () => events.value.length > 0 && events.value.every((e) => open.value.has(e.seq)),
);
function toggleAll(): void {
  open.value = allOpen.value ? new Set() : new Set(events.value.map((e) => e.seq));
}
function toggle(seq: number): void {
  const next = new Set(open.value);
  if (next.has(seq)) next.delete(seq);
  else next.add(seq);
  open.value = next;
}

async function seek(seq: number): Promise<void> {
  folded.value = false;
  open.value = new Set([...open.value, seq]);
  await nextTick();
  list.value?.scrollToSeq(seq);
}
function scrollOnly(seq: number): void {
  list.value?.scrollToSeq(seq);
}

const counts = computed(() => timelineCounts(events.value));
const legend = computed(() => timelineLegend(props.detail));
const hasMcp = computed(() => events.value.some((e) => e.server));
const foldedLine = computed(() => {
  const total = formatCount(Math.max(props.detail.timeline.totalEvents, events.value.length));
  const category = props.detail.executionError?.category;
  const before = category === 'timeout' ? 'the timeout' : 'the run stopped';
  const last = events.value[events.value.length - 1];
  return `${total} events before ${before}${last?.running ? '; the last one is still open' : ''}`;
});

const emptyLine = computed(() => {
  if (props.detail.status === 'queued') return 'No events yet: the run is queued.';
  if (live.value) return 'No events yet: the run has just started.';
  if (props.detail.shownAttempt === 0) return 'No events: the run never started.';
  return 'No events were recorded for this attempt.';
});

defineExpose({ seek });
</script>

<template>
  <section
    v-if="folded"
    :id="sectionId"
    aria-labelledby="ri-h-timeline"
    class="flex flex-wrap items-center justify-between gap-10 rounded-6 border border-border bg-surface px-12 py-10"
    data-testid="section-timeline"
    data-folded="true"
  >
    <div class="flex flex-wrap items-baseline gap-8">
      <SectionHeading id="ri-h-timeline" :n="2" title="Timeline" />
      <span class="text-text-2">{{ foldedLine }}</span>
    </div>
    <button type="button" class="btn" @click="folded = false">Show timeline</button>
  </section>
  <section
    v-else
    :id="sectionId"
    aria-labelledby="ri-h-timeline"
    class="flex flex-col gap-10"
    data-testid="section-timeline"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-12">
      <SectionHeading id="ri-h-timeline" :n="2" title="Timeline">
        <span v-if="live" class="text-12 font-normal text-text-3" data-testid="timeline-live"
          >{{ formatCount(events.length) }} {{ events.length === 1 ? 'event' : 'events' }} ·
          live</span
        >
      </SectionHeading>
      <span v-if="events.length" class="text-12 text-text-3" data-testid="timeline-counts">
        <template v-if="!live">{{ counts }} · </template>
        <button type="button" class="linkbtn text-12" @click="toggleAll">
          {{ allOpen ? 'Collapse all' : 'Expand all' }}
        </button>
      </span>
    </div>
    <template v-if="events.length">
      <TimelineScrubber
        :events="events"
        :open="open"
        :viewport="viewport"
        @seek="seek"
        @scroll="scrollOnly"
      />
      <EventTimeline
        ref="list"
        :events="events"
        :open="open"
        :live="live"
        @toggle="toggle"
        @viewport="viewport = $event"
      />
      <div class="mt-4 flex flex-wrap gap-x-16 gap-y-6 text-12 text-text-3" data-testid="legend">
        <span class="inline-flex items-center gap-6"
          ><span class="inline-block h-14 w-6 rounded-2 bg-text-3" />tool</span
        >
        <span v-if="hasMcp" class="inline-flex items-center gap-6"
          ><span class="inline-block h-14 w-6 rounded-2 bg-accent" />MCP tool</span
        >
        <span class="inline-flex items-center gap-6"
          ><span
            class="inline-block h-10 w-6 rounded-2 inset-ring-[1.5px] inset-ring-text-2"
          />network (model call)</span
        >
        <span class="inline-flex items-center gap-6"
          ><span
            class="inline-block h-10 w-6 rounded-2 bg-[repeating-linear-gradient(135deg,var(--text-3)_0_1.5px,transparent_1.5px_3.5px)]"
          />refused connection, Hermes background (neutral)</span
        >
        <span class="inline-flex items-center gap-6"
          ><span class="inline-block h-18 w-6 rounded-2 bg-fail" />error, including a refusal caused
          by the agent's own call</span
        >
        <span v-if="legend">{{ legend }}</span>
      </div>
    </template>
    <div
      v-else
      class="rounded-6 border border-dashed border-border-strong bg-surface px-14 py-12 text-text-2"
    >
      {{ emptyLine }}
    </div>
  </section>
</template>

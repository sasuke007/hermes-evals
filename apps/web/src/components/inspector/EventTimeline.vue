<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, toRef, watch } from 'vue';
import { useVirtualList } from '@vueuse/core';
import type { TimelineEvent } from '@/api/types/runs';
import TimelineEventRow from './TimelineEventRow.vue';

/**
 * The run's events in order (Components 2 › EventTimeline), in a scroll box so the scrubber
 * above can bracket what is in view. Above 200 events only the rows in view are rendered
 * (useVirtualList), at their measured heights. While the run is live it follows the newest
 * event until the user scrolls up; then a "Jump to latest · N new" pill counts what arrived
 * since (RunInspectorStates › Running).
 *
 * Exposes scrollToSeq(seq) for the scrubber and the Outcome's evidence links.
 */
const props = withDefaults(
  defineProps<{
    events: TimelineEvent[];
    /** Seqs of the expanded rows. */
    open: Set<number>;
    live?: boolean;
    /** Virtualise above this many events. */
    virtualAbove?: number;
  }>(),
  { live: false, virtualAbove: 200 },
);
const emit = defineEmits<{
  toggle: [seq: number];
  /** Indexes of the first and last event in view, or null when every event is. */
  viewport: [range: { first: number; last: number } | null];
}>();

/** A collapsed row: 36px and its border; a refusal sub-row adds 32px and its border. */
const ROW_HEIGHT = 37;
const REFUSAL_HEIGHT = 33;

const events = toRef(props, 'events');
const virtual = computed(() => props.events.length > props.virtualAbove);
/** Measured row heights, by seq and whether the row was open. */
const heights = reactive(new Map<string, number>());
const heightKey = (seq: number): string => `${seq}:${props.open.has(seq) ? 1 : 0}`;

function itemHeight(index: number): number {
  const event = props.events[index];
  if (!event) return ROW_HEIGHT;
  return (
    heights.get(heightKey(event.seq)) ??
    ROW_HEIGHT + (event.kind === 'tool' && event.refusal ? REFUSAL_HEIGHT : 0)
  );
}

const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(events, {
  itemHeight,
  overscan: 12,
});
const container = containerProps.ref;
const rows = computed(() =>
  virtual.value ? list.value : props.events.map((data, index) => ({ data, index })),
);

/** Record each rendered row's real height (expanded rows differ), for the virtual offsets. */
function measure(): void {
  const box = container.value;
  if (!box) return;
  box.querySelectorAll<HTMLElement>('[data-seq]').forEach((el) => {
    const key = heightKey(Number(el.dataset.seq));
    const h = el.offsetHeight;
    if (h > 0 && heights.get(key) !== h) heights.set(key, h);
  });
}

// ── following the newest event, and the viewport bracket ─────────────────
const following = ref(true);
const fresh = ref(0);
let frame = 0;

function atBottom(box: HTMLElement): boolean {
  return box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
}

function offsetOf(index: number): number {
  let top = 0;
  for (let i = 0; i < index; i++) top += itemHeight(i);
  return top;
}

function reportViewport(): void {
  const box = container.value;
  if (!box || box.scrollHeight <= box.clientHeight + 1) {
    emit('viewport', null);
    return;
  }
  const top = box.scrollTop;
  const bottom = top + box.clientHeight;
  let y = 0;
  let first = -1;
  let last = props.events.length - 1;
  for (let i = 0; i < props.events.length; i++) {
    const h = itemHeight(i);
    if (first < 0 && y + h > top) first = i;
    if (y >= bottom) {
      last = i - 1;
      break;
    }
    y += h;
  }
  emit('viewport', { first: Math.max(0, first), last: Math.max(0, last) });
}

function onScroll(): void {
  containerProps.onScroll();
  const box = container.value;
  if (!box) return;
  following.value = atBottom(box);
  if (following.value) fresh.value = 0;
  if (typeof requestAnimationFrame === 'undefined') return reportViewport();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(reportViewport);
}

function scrollToEnd(): void {
  const box = container.value;
  if (!box) return;
  box.scrollTop = box.scrollHeight;
  following.value = true;
  fresh.value = 0;
}

/** Scroll the list so the event with this seq is at the top. */
function scrollToSeq(seq: number): void {
  const index = props.events.findIndex((e) => e.seq === seq);
  const box = container.value;
  if (index < 0 || !box) return;
  if (virtual.value) {
    scrollTo(index);
    return;
  }
  const el = box.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
  box.scrollTop = el ? el.offsetTop : offsetOf(index);
}

watch(
  () => props.events.length,
  async (length, before) => {
    await nextTick();
    measure();
    if (props.live && length > (before ?? 0)) {
      if (following.value) scrollToEnd();
      else fresh.value += length - (before ?? 0);
    }
    reportViewport();
  },
);
watch([() => props.open, list], async () => {
  await nextTick();
  measure();
  reportViewport();
});
watch(
  () => props.live,
  (live) => {
    if (!live) fresh.value = 0;
  },
);

onMounted(async () => {
  await nextTick();
  measure();
  if (props.live) scrollToEnd();
  reportViewport();
});

defineExpose({ scrollToSeq, scrollToEnd });
</script>

<template>
  <div class="relative">
    <div
      :ref="containerProps.ref"
      class="relative max-h-[min(640px,70vh)] overflow-y-auto rounded-6 border border-border bg-surface"
      role="list"
      aria-label="Timeline events"
      data-testid="event-list"
      :data-virtual="virtual ? 'true' : undefined"
      @scroll="onScroll"
    >
      <div v-bind="virtual ? wrapperProps : {}" role="presentation">
        <TimelineEventRow
          v-for="row in rows"
          :key="row.data.seq"
          role="listitem"
          :aria-setsize="virtual ? events.length : undefined"
          :aria-posinset="virtual ? row.index + 1 : undefined"
          :event="row.data"
          :open="open.has(row.data.seq)"
          @toggle="emit('toggle', row.data.seq)"
        />
      </div>
    </div>
    <button
      v-if="live && fresh > 0"
      type="button"
      class="btn mid absolute right-12 -bottom-14 rounded-[14px] border-accent bg-accent text-on-accent shadow-float hover:bg-accent-hover hover:text-on-accent"
      data-testid="jump-to-latest"
      @click="scrollToEnd"
    >
      Jump to latest · {{ fresh }} new
    </button>
  </div>
</template>

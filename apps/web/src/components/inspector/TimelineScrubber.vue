<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { TimelineEvent } from '@/api/types/runs';
import { EVENT_TICK, LOOK_PRIORITY, eventLook, type EventLook } from './inspectorFormat';

/**
 * The strip above the event list (Components 2 › TimelineScrubber; RunInspector): one tick
 * per event at even spacing, not in time, so long runs stay legible. Tool ticks are tall, MCP
 * ticks accent, text ticks short, errors tall and orange, model calls hollow, Hermes's
 * background refusals hatched; an open row's tick is outlined in accent, and the focused
 * tick in --text further out (the focus colour is the accent, so after Expand all a focus
 * ring alone would look like every open tick). Past MAX_TICKS events a tick
 * stands for a few neighbours and takes the look that matters most among them.
 *
 * Clicking a tick (or Enter on it) seeks: the list scrolls to the event and opens it.
 * Dragging across the strip scrolls the list without opening anything. The ticks are one tab
 * stop; arrow keys, Home and End move between them. The bracket marks the part of the list
 * in view.
 */
const props = defineProps<{
  events: TimelineEvent[];
  open: Set<number>;
  /** Indexes of the first and last event in view, or null when all are. */
  viewport: { first: number; last: number } | null;
}>();
const emit = defineEmits<{ seek: [seq: number]; scroll: [seq: number] }>();

const MAX_TICKS = 160;

interface Tick {
  /** The event a click opens: the bucket's most telling one. */
  seq: number;
  look: EventLook;
  open: boolean;
  label: string;
  /** Event indexes this tick stands for. */
  from: number;
  to: number;
}

const size = computed(() => Math.max(1, Math.ceil(props.events.length / MAX_TICKS)));

const ticks = computed<Tick[]>(() => {
  const out: Tick[] = [];
  const events = props.events;
  for (let from = 0; from < events.length; from += size.value) {
    const group = events.slice(from, from + size.value);
    let best = group[0];
    for (const e of group) {
      if (best && LOOK_PRIORITY.indexOf(eventLook(e)) < LOOK_PRIORITY.indexOf(eventLook(best))) {
        best = e;
      }
    }
    if (!best) continue;
    const to = from + group.length - 1;
    out.push({
      seq: best.seq,
      look: eventLook(best),
      open: group.some((e) => props.open.has(e.seq)),
      label:
        group.length === 1
          ? `Go to event ${from + 1}: ${best.title}`
          : `Go to events ${from + 1} to ${to + 1}: ${best.title}`,
      from,
      to,
    });
  }
  return out;
});

const dense = computed(() => ticks.value.length > 40);
const tickEls = ref<HTMLElement[]>([]);
const strip = ref<HTMLElement | null>(null);

// ── one tab stop, arrow keys between ticks ────────────────────────────────
const active = ref(0);
watch(
  () => ticks.value.length,
  (n) => {
    if (active.value >= n) active.value = Math.max(0, n - 1);
  },
);

function focusTick(index: number): void {
  const n = ticks.value.length;
  if (!n) return;
  active.value = Math.min(n - 1, Math.max(0, index));
  void nextTick(() => tickEls.value[active.value]?.focus());
}

function onKeydown(event: KeyboardEvent): void {
  const moves: Record<string, number> = {
    ArrowLeft: active.value - 1,
    ArrowRight: active.value + 1,
    Home: 0,
    End: ticks.value.length - 1,
  };
  const next = moves[event.key];
  if (next === undefined) return;
  event.preventDefault();
  focusTick(next);
}

// ── click to seek, drag to scroll ──────────────────────────────────────────
let dragging = false;
let dragged = false;

function tickAt(x: number): Tick | null {
  let best: Tick | null = null;
  let distance = Infinity;
  tickEls.value.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const d = Math.abs(rect.left + rect.width / 2 - x);
    if (d < distance) {
      distance = d;
      best = ticks.value[i] ?? null;
    }
  });
  return best;
}

function onPointerDown(event: PointerEvent): void {
  dragging = true;
  dragged = false;
  strip.value?.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging || event.buttons === 0) return;
  const tick = tickAt(event.clientX);
  if (!tick) return;
  dragged = true;
  emit('scroll', tick.seq);
}

function onPointerUp(): void {
  dragging = false;
}

function onTickClick(index: number, tick: Tick): void {
  if (dragged) {
    dragged = false;
    return;
  }
  active.value = index;
  emit('seek', tick.seq);
}

// ── the bracket over the ticks in view ─────────────────────────────────────
const bracket = computed(() => {
  const v = props.viewport;
  if (!v || !ticks.value.length) return null;
  return {
    first: Math.floor(v.first / size.value),
    last: Math.min(ticks.value.length - 1, Math.floor(v.last / size.value)),
  };
});
const bracketStyle = ref<Record<string, string> | null>(null);
watch(
  [bracket, () => ticks.value.length],
  async () => {
    await nextTick();
    const b = bracket.value;
    const first = b ? tickEls.value[b.first] : undefined;
    const last = b ? tickEls.value[b.last] : undefined;
    if (!b || !first || !last) {
      bracketStyle.value = null;
      return;
    }
    const left = first.offsetLeft - 3;
    bracketStyle.value = {
      left: `${left}px`,
      width: `${last.offsetLeft + last.offsetWidth + 3 - left}px`,
    };
  },
  { immediate: true },
);
</script>

<template>
  <div
    ref="strip"
    class="relative flex h-34 items-end rounded-4 border border-border bg-surface-2 px-8 py-4 select-none"
    :class="dense ? 'gap-2' : 'gap-4'"
    role="group"
    aria-label="Timeline overview"
    data-testid="timeline-scrubber"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <button
      v-for="(tick, i) in ticks"
      :key="`${tick.from}-${tick.seq}`"
      ref="tickEls"
      type="button"
      class="flex-1 cursor-pointer rounded-2 border-0 p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text"
      :class="[
        EVENT_TICK[tick.look],
        dense ? 'max-w-8 min-w-1' : 'max-w-48 min-w-6',
        tick.open ? 'outline-2 outline-offset-1 outline-accent' : '',
      ]"
      :tabindex="i === active ? 0 : -1"
      :aria-label="tick.label"
      :data-look="tick.look"
      :data-open="tick.open ? 'true' : undefined"
      data-testid="scrubber-tick"
      @click="onTickClick(i, tick)"
    />
    <div
      v-if="bracketStyle"
      class="pointer-events-none absolute -top-1 -bottom-1 rounded-3 border-[1.5px] border-accent bg-accent/5"
      :style="bracketStyle"
      aria-hidden="true"
      data-testid="scrubber-viewport"
    />
  </div>
</template>

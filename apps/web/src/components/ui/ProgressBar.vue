<script setup lang="ts">
import { computed } from 'vue';
import { TONE_CLASSES, toneVars } from '@/lib/statusTones';
import type { ProgressSegment } from './types';

/**
 * A progress bar on --surface-3, one segment or several in pipeline order (ExperimentList's
 * runs scored, OverviewRunning's status breakdown and per-configuration bars, the spend
 * line). Widths ease over 300ms when counts change (Main › Motion). role="progressbar" with
 * min, max, now and a label that says it in words: "87 of 120 runs scored".
 */
const props = withDefaults(
  defineProps<{
    max: number;
    /** One segment: its value; or pass `segments`. */
    value?: number | null;
    tone?: ProgressSegment['tone'];
    segments?: ProgressSegment[] | null;
    /** aria-valuenow; defaults to `value`, or the sum of the segments. */
    now?: number | null;
    label: string;
    /** Height in px: 4 spend, 6 list rows, 8 per configuration, 10 or 12 breakdowns. */
    height?: 4 | 6 | 8 | 10 | 12;
    /** CSS width; default the container's. */
    width?: number | string | null;
  }>(),
  { value: null, tone: 'pass', segments: null, now: null, height: 6, width: null },
);

const parts = computed<ProgressSegment[]>(
  () => props.segments ?? [{ value: props.value ?? 0, tone: props.tone }],
);
const valueNow = computed(
  () => props.now ?? props.value ?? parts.value.reduce((sum, s) => sum + s.value, 0),
);
const share = (value: number): string =>
  props.max > 0 ? `${Math.max(0, Math.min(100, (value / props.max) * 100)).toFixed(2)}%` : '0%';

function segmentClass(segment: ProgressSegment): (string | Record<string, boolean>)[] {
  const fill =
    segment.pattern === 'hatch'
      ? ''
      : segment.tone === 'muted'
        ? 'bg-text-3'
        : TONE_CLASSES[segment.tone].solid;
  return [fill, { 'animate-live': !!segment.pulse }];
}
function segmentStyle(segment: ProgressSegment): Record<string, string> {
  const style: Record<string, string> = { width: share(segment.value) };
  if (segment.pattern === 'hatch' && segment.tone !== 'muted') {
    const v = toneVars(segment.tone);
    style.background = `repeating-linear-gradient(135deg, ${v.solid} 0 2px, ${v.soft} 2px 4px)`;
  }
  return style;
}

const radius = computed(() =>
  props.height === 6 || props.height === 12 ? 'rounded-3' : 'rounded-2',
);
const css = (w: number | string | null): string | undefined =>
  w === null ? undefined : typeof w === 'number' ? `${w}px` : w;
</script>

<template>
  <div
    class="flex flex-none overflow-hidden bg-surface-3"
    :class="radius"
    :style="{ height: `${height}px`, width: css(width) }"
    role="progressbar"
    aria-valuemin="0"
    :aria-valuemax="max"
    :aria-valuenow="valueNow"
    :aria-label="label"
  >
    <div
      v-for="(segment, i) in parts"
      :key="i"
      class="h-full transition-[width] duration-300"
      :class="segmentClass(segment)"
      :style="segmentStyle(segment)"
      :title="segment.label"
      data-testid="progress-segment"
    />
  </div>
</template>

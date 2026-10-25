<script setup lang="ts">
import { computed } from 'vue';
import { formatSigned } from '@/lib/format';
import { TONE_CLASSES, type Tone } from '@/lib/statusTones';
import { axisTick as tick, intervalHalfWidth } from './intervalAxis';

/**
 * A number line centred on zero (Components 2 › IntervalBar): the 95% interval as a bar, the
 * observed difference as a point. The domain is symmetric, at least ±0.2 and rounded up to a
 * multiple of 0.2 (intervalAxis.ts), so zero is always in the middle, crossing it shows at
 * once, and the quarter ticks read true with one decimal.
 *   md  48px, ticks at the quarters, five labels (the Comparison statistics panel)
 *   sm  34px, three labels (inside VerdictCard)
 * Tone follows the verdict (better pass, worse fail, inconclusive neutral, provisional
 * dashed), else the interval itself. Accessible as an image with a sentence:
 * "Difference +0.217, 95% interval +0.117 to +0.333, entirely above zero".
 */
type IntervalTone = Tone | 'provisional';

const props = withDefaults(
  defineProps<{
    lo: number;
    hi: number;
    /** The observed difference. */
    point: number;
    /** Fixed half-width of the domain; default from the data. */
    domain?: number | null;
    verdict?: 'better' | 'worse' | 'inconclusive' | 'provisional' | null;
    tone?: IntervalTone | null;
    size?: 'sm' | 'md';
    /** Replaces the generated aria-label. */
    label?: string | null;
  }>(),
  { domain: null, verdict: null, tone: null, size: 'md', label: null },
);

/** The half-width of the axis: the `domain` given, else from the data (intervalAxis.ts). */
const half = computed<number>(() => {
  if (props.domain !== null && props.domain > 0) return props.domain;
  return intervalHalfWidth(props.lo, props.hi, props.point);
});

const pct = (v: number): number => {
  const d = half.value;
  return Math.min(100, Math.max(0, ((v + d) / (2 * d)) * 100));
};

const tone = computed<IntervalTone>(() => {
  if (props.tone) return props.tone;
  switch (props.verdict) {
    case 'better':
      return 'pass';
    case 'worse':
      return 'fail';
    case 'inconclusive':
      return 'que';
    case 'provisional':
      return 'provisional';
    default:
      return props.lo > 0 ? 'pass' : props.hi < 0 ? 'fail' : 'que';
  }
});

const RINGS: Record<Tone, string> = {
  pass: 'inset-ring-pass',
  fail: 'inset-ring-fail',
  err: 'inset-ring-err',
  ung: 'inset-ring-ung',
  run: 'inset-ring-run',
  que: 'inset-ring-que',
};
const barClass = computed(() =>
  tone.value === 'provisional'
    ? 'border-[1.5px] border-dashed border-text-3 bg-que-soft'
    : [TONE_CLASSES[tone.value].soft, 'inset-ring-[1.5px]', RINGS[tone.value]],
);
const pointClass = computed(() =>
  tone.value === 'provisional' ? 'bg-text-3' : TONE_CLASSES[tone.value].solid,
);

const where = computed(() =>
  props.lo > 0 ? 'entirely above zero' : props.hi < 0 ? 'entirely below zero' : 'crosses zero',
);
const aria = computed(
  () =>
    props.label ??
    `Difference ${formatSigned(props.point)}, 95% interval ${formatSigned(props.lo)} to ${formatSigned(props.hi)}, ${where.value}`,
);

const md = computed(() => props.size === 'md');
/** Vertical positions, px, per size (Components 2: VerdictCard and the statistics row). */
const y = computed(() =>
  md.value
    ? { height: 48, axis: 18, zero: 4, zeroH: 30, bar: 12, labels: 30 }
    : { height: 34, axis: 12, zero: 2, zeroH: 22, bar: 6, labels: 22 },
);
</script>

<template>
  <div
    role="img"
    :aria-label="aria"
    class="relative"
    :style="{ height: `${y.height}px` }"
    :data-tone="tone"
    :data-domain="half"
  >
    <div class="absolute inset-x-0 h-1 bg-border-strong" :style="{ top: `${y.axis}px` }" />
    <template v-if="md">
      <div class="absolute left-1/4 h-9 w-1 bg-border-strong" :style="{ top: `${y.axis - 4}px` }" />
      <div class="absolute left-3/4 h-9 w-1 bg-border-strong" :style="{ top: `${y.axis - 4}px` }" />
    </template>
    <div
      class="absolute left-1/2 w-1 bg-text-2"
      :style="{ top: `${y.zero}px`, height: `${y.zeroH}px` }"
    />
    <div
      class="absolute h-12 rounded-2"
      :class="barClass"
      :style="{ top: `${y.bar}px`, left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }"
      data-testid="interval-bar"
    />
    <div
      class="absolute -ml-7 size-14 rounded-full ring-2 ring-surface"
      :class="pointClass"
      :style="{ top: `${y.bar - 1}px`, left: `${pct(point)}%` }"
      data-testid="interval-point"
    />
    <div class="absolute left-0 font-mono text-11 text-text-3" :style="{ top: `${y.labels}px` }">
      {{ tick(-half) }}
    </div>
    <div
      v-if="md"
      class="absolute left-1/4 -translate-x-1/2 font-mono text-11 text-text-3"
      :style="{ top: `${y.labels}px` }"
    >
      {{ tick(-half / 2) }}
    </div>
    <div
      class="absolute left-1/2 -translate-x-1/2 font-mono text-11"
      :class="md ? 'text-text-2' : 'text-text-3'"
      :style="{ top: `${y.labels}px` }"
    >
      0
    </div>
    <div
      v-if="md"
      class="absolute left-3/4 -translate-x-1/2 font-mono text-11 text-text-3"
      :style="{ top: `${y.labels}px` }"
    >
      {{ tick(half / 2) }}
    </div>
    <div class="absolute right-0 font-mono text-11 text-text-3" :style="{ top: `${y.labels}px` }">
      {{ tick(half) }}
    </div>
  </div>
</template>

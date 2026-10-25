<script setup lang="ts">
import { computed } from 'vue';
import { axisTick as tick, intervalHalfWidth } from '@/components/ui/intervalAxis';
import { formatSigned } from '@/lib/format';
import { TONE_CLASSES, type Tone } from '@/lib/statusTones';

/**
 * The statistics panel's number line (Comparison board, 64px): the axis centred on zero with
 * "no difference" over the zero line, the 95% interval as a bar with its bounds written under
 * each end, and the observed difference as a point. The domain follows IntervalBar's rule
 * (Components 2; src/components/ui/intervalAxis.ts): symmetric, at least ±0.2 and rounded up
 * to a multiple of 0.2, so crossing zero shows at once and the quarter ticks read true. Tone
 * follows the verdict: better pass, worse fail, inconclusive neutral, provisional dashed.
 * IntervalBar (src/components/ui) is the 48px and 34px versions of the same figure.
 */
type ChartTone = Tone | 'provisional';

const props = withDefaults(
  defineProps<{
    lo: number;
    hi: number;
    /** The observed difference. */
    point: number;
    verdict: 'better' | 'worse' | 'inconclusive' | 'provisional' | 'not_computable';
    /** Replaces the generated aria-label. */
    label?: string | null;
  }>(),
  { label: null },
);

const half = computed<number>(() => intervalHalfWidth(props.lo, props.hi, props.point));

const pct = (v: number): number =>
  Math.min(100, Math.max(0, ((v + half.value) / (2 * half.value)) * 100));

const tone = computed<ChartTone>(() => {
  switch (props.verdict) {
    case 'better':
      return 'pass';
    case 'worse':
      return 'fail';
    case 'provisional':
      return 'provisional';
    default:
      return 'que';
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
/** The bounds' labels: the tone's text colour, --text-2 for the neutral ones. */
const boundClass = computed(() =>
  tone.value === 'provisional' || tone.value === 'que'
    ? 'text-text-2'
    : TONE_CLASSES[tone.value].text,
);

const where = computed(() =>
  props.lo > 0 ? 'entirely above zero' : props.hi < 0 ? 'entirely below zero' : 'crosses zero',
);
const aria = computed(
  () =>
    props.label ??
    `Difference ${formatSigned(props.point)}, 95% interval ${formatSigned(props.lo)} to ${formatSigned(props.hi)}, ${where.value}`,
);

/** A bound's label sits centred under its end, kept inside the line near either edge. */
const anchor = (v: number): string => {
  const at = pct(v);
  return at < 8 ? 'translate-x-0' : at > 92 ? '-translate-x-full' : '-translate-x-1/2';
};
</script>

<template>
  <div
    role="img"
    :aria-label="aria"
    class="relative mx-8 mt-4 h-64"
    :data-tone="tone"
    :data-domain="half"
  >
    <div class="absolute inset-x-0 top-24 h-1 bg-border-strong" />
    <div class="absolute top-20 left-0 h-9 w-1 bg-border-strong" />
    <div class="absolute top-20 left-1/4 h-9 w-1 bg-border-strong" />
    <div class="absolute top-20 left-3/4 h-9 w-1 bg-border-strong" />
    <div class="absolute top-20 right-0 h-9 w-1 bg-border-strong" />
    <div class="absolute top-6 left-1/2 h-38 w-[1.5px] bg-text-2" />
    <div class="absolute -top-4 left-1/2 -translate-x-1/2 text-12 text-text-3">no difference</div>
    <div
      class="absolute top-17 h-14 rounded-2"
      :class="barClass"
      :style="{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }"
      data-testid="interval-bar"
    />
    <div
      class="absolute top-16 -ml-8 size-16 rounded-full ring-2 ring-surface"
      :class="pointClass"
      :style="{ left: `${pct(point)}%` }"
      data-testid="interval-point"
    />
    <div
      class="absolute top-34 font-mono text-11"
      :class="[boundClass, anchor(lo)]"
      :style="{ left: `${pct(lo)}%` }"
      data-testid="interval-lo"
    >
      {{ formatSigned(lo) }}
    </div>
    <div
      class="absolute top-34 font-mono text-11"
      :class="[boundClass, anchor(hi)]"
      :style="{ left: `${pct(hi)}%` }"
      data-testid="interval-hi"
    >
      {{ formatSigned(hi) }}
    </div>
    <div class="absolute top-48 left-0 font-mono text-11 text-text-3">{{ tick(-half) }}</div>
    <div class="absolute top-48 left-1/4 -translate-x-1/2 font-mono text-11 text-text-3">
      {{ tick(-half / 2) }}
    </div>
    <div class="absolute top-48 left-1/2 -translate-x-1/2 font-mono text-11 text-text-2">0</div>
    <div class="absolute top-48 left-3/4 -translate-x-1/2 font-mono text-11 text-text-3">
      {{ tick(half / 2) }}
    </div>
    <div class="absolute top-48 right-0 font-mono text-11 text-text-3">{{ tick(half) }}</div>
  </div>
</template>

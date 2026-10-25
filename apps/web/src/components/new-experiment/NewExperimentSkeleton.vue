<script setup lang="ts">
/**
 * New experiment's first load (ExperimentStates › New experiment · loading and load error):
 * skeleton bars at the real layout, the form sections on the left and the summary panel on the
 * right, so nothing shifts when the suites and configurations arrive.
 */
const BAR = 'block animate-shimmer rounded-3 bg-surface-3';
const SECTIONS: (number | string)[][] = [
  [200, '100%'],
  [280, 160, 120],
  [90, 300, 60],
  [90, 260, 60],
];
</script>

<template>
  <div
    class="flex flex-wrap items-start gap-20"
    aria-busy="true"
    aria-label="Loading suites and configurations"
    data-testid="new-experiment-skeleton"
  >
    <div class="flex min-w-0 flex-[999_1_640px] flex-col gap-16" aria-hidden="true">
      <div
        v-for="(bars, i) in SECTIONS"
        :key="i"
        class="flex flex-col gap-14 rounded-6 border border-border bg-surface p-20"
      >
        <span :class="BAR" class="w-160 h-14" />
        <div class="flex flex-wrap items-center gap-8">
          <span
            v-for="(w, j) in bars"
            :key="j"
            :class="BAR"
            :style="{
              width: typeof w === 'number' ? `${w}px` : w,
              height: j === 1 && i === 0 ? '32px' : '10px',
            }"
          />
        </div>
      </div>
    </div>
    <div
      class="flex max-w-380 min-w-0 flex-[1_1_320px] flex-col gap-12 rounded-6 border border-border bg-surface p-18 max-lg:max-w-none"
      aria-hidden="true"
    >
      <span :class="BAR" class="h-14 w-80" />
      <span
        v-for="w in [140, 160, 120]"
        :key="w"
        :class="BAR"
        class="h-10"
        :style="{ width: `${w}px` }"
      />
      <span :class="BAR" class="h-28 w-64 self-end" />
      <span :class="BAR" class="h-32 w-full" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { ExperimentListRow, ExperimentListVerdict } from '@/api/types/experiments';
import { TONE_CLASSES, statusTone } from '@/lib/statusTones';
import { ROUTE_NAMES } from '@/router';
import { noIntervalText, noVerdictText, verdictTitle } from './listText';

/**
 * The Verdict column of the Experiment list: once the experiment has completed, one chip per
 * candidate ("with-skill better", with Δ and its interval as the tooltip) that opens the
 * Comparison tab with that candidate selected. A candidate without an interval reads why
 * ("No interval (1 rep)"). A running or paused row says "Provisional"; a failed one has none.
 */
const props = defineProps<{ row: ExperimentListRow }>();

interface Chip {
  verdict: ExperimentListVerdict;
  word: string;
  classes: string[];
  title: string;
  label: string;
}

const labelOf = (verdict: ExperimentListVerdict, word: string, title: string): string =>
  `${verdict.candidate} ${word}${title === word ? '' : `, ${title}`}. Open the comparison`;

const chips = computed<Chip[]>(() =>
  props.row.verdicts.map((verdict) => {
    if (verdict.verdict === 'not_computable') {
      const word = noIntervalText(verdict.reason, props.row);
      const classes = ['bg-surface-2', 'text-text-3'];
      return { verdict, word, classes, title: word, label: labelOf(verdict, word, word) };
    }
    const tone = statusTone('verdict', verdict.verdict);
    const look = TONE_CLASSES[tone.tone];
    const title = verdictTitle(verdict);
    return {
      verdict,
      word: tone.label,
      classes: [look.chip, look.ring],
      title,
      label: labelOf(verdict, tone.label, title),
    };
  }),
);

const toComparison = (verdict: ExperimentListVerdict) => ({
  name: ROUTE_NAMES.experimentComparison,
  params: { id: props.row.id },
  query: { candidate: verdict.candidateVersionId },
});
</script>

<template>
  <div class="flex flex-wrap items-center gap-6" data-testid="verdict-cell">
    <RouterLink
      v-for="chip in chips"
      :key="chip.verdict.candidateVersionId"
      :to="toComparison(chip.verdict)"
      class="chip gap-6 no-underline hover:no-underline"
      :class="chip.classes"
      :title="chip.title"
      :aria-label="chip.label"
      :data-verdict="chip.verdict.verdict"
      data-testid="verdict-chip"
    >
      <span
        class="inline-block max-w-160 truncate align-bottom font-mono font-medium"
        :title="chip.verdict.candidate"
        >{{ chip.verdict.candidate }}</span
      >{{ ' ' }}<span>{{ chip.word }}</span>
    </RouterLink>
    <span v-if="chips.length === 0" class="text-text-3" data-testid="no-verdict">{{
      noVerdictText(row)
    }}</span>
  </div>
</template>

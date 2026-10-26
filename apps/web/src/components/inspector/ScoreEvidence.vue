<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ScoreEvidenceView } from '@/api/types/runs';
import { formatCount, formatUsd } from '@/lib/format';
import { formatEventDuration, formatTokensInOut } from './inspectorFormat';
import { JSON_MATCH_ROWS_SHOWN, jsonMatchCaption, jsonMatchRows } from './jsonMatchRows';
import RichSentence from './RichSentence.vue';

/**
 * What a scorer recorded behind a score (Phase 3 and 4: ScoreRowView.evidence), drawn in
 * the score's evidence expander (RunInspectorStates › JSON match with partial credit):
 * json_match key by key with both values (or, on a row stored before Phase 7, the
 * mismatches' paths), text_match's phrases found or not, what
 * trajectory_match counted, the LLM judge's model, calls, tokens and grading cost, and the
 * timeline events the score points at (each one a button that opens it in the timeline).
 */
const props = defineProps<{ evidence: ScoreEvidenceView }>();
const emit = defineEmits<{ seek: [seq: number] }>();

const json = computed(() => props.evidence.jsonMatch);
const rows = computed(() => (json.value ? jsonMatchRows(json.value) : []));
/** A long table shows its first rows and every mismatch until Show all. */
const showAll = ref(false);
watch(json, () => (showAll.value = false));
const tableRows = computed(() =>
  showAll.value ? rows.value : rows.value.filter((r, i) => !r.match || i < JSON_MATCH_ROWS_SHOWN),
);
const hiddenRows = computed(() => rows.value.length - tableRows.value.length);
const text = computed(() => props.evidence.text);
const trajectory = computed(() => props.evidence.trajectory);
const judge = computed(() => props.evidence.judge);
/** Event pointers not already listed as trajectory_match's matched calls. */
const pointers = computed(() => {
  const matched = new Set(trajectory.value?.matchedSeqs ?? []);
  return props.evidence.eventSeqs.filter((seq) => !matched.has(seq));
});

const unitWord = (unit: 'keys' | 'items' | 'value', n: number): string =>
  unit === 'keys' ? (n === 1 ? 'key' : 'keys') : n === 1 ? 'item' : 'items';

const callLog = computed(() =>
  (judge.value?.callLog ?? [])
    .map((c) => `${c.status ?? 'no answer'} in ${formatEventDuration(c.latencyMs)}`)
    .join(', then '),
);
</script>

<template>
  <div class="flex flex-col gap-8 text-12 leading-18" data-testid="score-evidence">
    <template v-if="json">
      <div
        v-if="tableRows.length"
        class="grid grid-cols-[18px_minmax(0,220px)_minmax(0,1fr)] items-baseline gap-x-10 gap-y-4"
        data-testid="json-match-table"
      >
        <template v-for="(row, i) in tableRows" :key="i">
          <span :class="row.match ? 'text-pass-text' : 'text-fail-text'" aria-hidden="true">{{
            row.match ? '✓' : '✗'
          }}</span>
          <span class="font-mono break-words" :class="{ 'font-semibold': !row.match }"
            >{{ row.label
            }}<span class="sr-only">{{ row.match ? ' matches' : ' does not match' }}</span></span
          >
          <span class="break-words" :class="row.match ? 'text-text-2' : 'text-fail-text'">{{
            row.note
          }}</span>
        </template>
      </div>
      <button
        v-if="hiddenRows > 0"
        type="button"
        class="linkbtn self-start text-12"
        data-testid="json-match-show-all"
        @click="showAll = true"
      >
        Show all {{ formatCount(rows.length) }} {{ unitWord(json.unit, rows.length) }} ({{
          formatCount(hiddenRows)
        }}
        more that match)
      </button>
      <div
        v-if="!rows.length && (json.mismatches.length || json.unit !== 'value')"
        class="grid grid-cols-[18px_minmax(0,1fr)] items-baseline gap-x-10 gap-y-4"
      >
        <template v-for="path in json.mismatches" :key="path">
          <span class="text-fail-text" aria-hidden="true">✗</span>
          <span
            ><span class="font-mono font-semibold">{{ path }}</span>
            <span class="text-fail-text"> does not match the reference</span></span
          >
        </template>
        <template v-if="json.matched > 0 && json.unit !== 'value'">
          <span class="text-pass-text" aria-hidden="true">✓</span>
          <span class="text-text-2"
            >{{ json.mismatches.length ? 'the other ' : 'all ' }}{{ formatCount(json.matched) }}
            {{ unitWord(json.unit, json.matched) }} match</span
          >
        </template>
      </div>
      <span class="text-text-3" data-testid="json-match-caption"
        ><RichSentence :text="jsonMatchCaption(json)"
      /></span>
    </template>

    <template v-if="text">
      <div class="grid grid-cols-[18px_64px_minmax(0,1fr)] items-baseline gap-x-10 gap-y-4">
        <template v-for="(item, i) in text.items" :key="i">
          <span :class="item.found ? 'text-pass-text' : 'text-fail-text'" aria-hidden="true">{{
            item.found ? '✓' : '✗'
          }}</span>
          <span class="text-text-3">{{ item.kind }}</span>
          <span
            ><code class="font-mono">{{ item.label }}</code>
            <span :class="item.found ? 'text-text-2' : 'text-fail-text'">{{
              item.found ? ' found' : ' not found'
            }}</span></span
          >
        </template>
      </div>
      <span v-if="text.truncated" class="text-text-3"
        >The answer is longer than 64 KB, so only its start was searched.</span
      >
    </template>

    <div v-if="trajectory" class="flex flex-wrap items-baseline gap-x-6 gap-y-4">
      <template v-if="trajectory.mode">
        <span>
          The whole trajectory was compared ({{ trajectory.mode }}):
          {{ formatCount(trajectory.calls) }} tool {{ trajectory.calls === 1 ? 'call' : 'calls' }}.
        </span>
      </template>
      <template v-else>
        <span>
          <code class="font-mono">{{ trajectory.tool }}</code> called
          {{ formatCount(trajectory.calls) }} {{ trajectory.calls === 1 ? 'time' : 'times' }}
        </span>
      </template>
      <template v-if="trajectory.matchedSeqs.length">
        <span class="text-text-3">· matching calls</span>
        <button
          v-for="seq in trajectory.matchedSeqs"
          :key="seq"
          type="button"
          class="linkbtn font-mono text-12"
          :aria-label="`Show event ${seq} in the timeline`"
          @click="emit('seek', seq)"
        >
          #{{ seq }}
        </button>
      </template>
    </div>

    <dl
      v-if="judge"
      class="grid grid-cols-[120px_minmax(0,1fr)] gap-x-16 gap-y-4"
      data-testid="judge-evidence"
    >
      <dt class="text-text-2">Judge model</dt>
      <dd>
        <code class="font-mono">{{ judge.model }}</code>
        <span class="text-text-2">
          on {{ judge.provider }}<template v-if="judge.baseUrl"> at {{ judge.baseUrl }}</template>
        </span>
      </dd>
      <dt class="text-text-2">Calls</dt>
      <dd>
        {{ judge.calls }}<span v-if="callLog" class="text-text-2"> · {{ callLog }}</span>
      </dd>
      <dt class="text-text-2">Tokens</dt>
      <dd>{{ formatTokensInOut(judge.tokens) }}</dd>
      <dt class="text-text-2">Grading cost</dt>
      <dd>
        <template v-if="judge.costUsd !== null">{{ formatUsd(judge.costUsd) }}</template>
        <span v-else class="text-text-3">no price for this model</span>
        <span class="text-text-3"> · counted apart from the run's own cost</span>
      </dd>
      <dt class="text-text-2">Latency</dt>
      <dd>{{ formatEventDuration(judge.latencyMs) }}</dd>
      <template v-if="judge.finishReason">
        <dt class="text-text-2">Finish reason</dt>
        <dd class="font-mono">{{ judge.finishReason }}</dd>
      </template>
    </dl>

    <div v-if="pointers.length" class="flex flex-wrap items-baseline gap-x-6 gap-y-4">
      <span class="text-text-3">Timeline {{ pointers.length === 1 ? 'event' : 'events' }}</span>
      <button
        v-for="seq in pointers"
        :key="seq"
        type="button"
        class="linkbtn font-mono text-12"
        :aria-label="`Show event ${seq} in the timeline`"
        @click="emit('seek', seq)"
      >
        #{{ seq }}
      </button>
    </div>
  </div>
</template>

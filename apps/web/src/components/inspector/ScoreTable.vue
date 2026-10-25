<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { ScoreRowView } from '@/api/types/runs';
import { MISSING, formatRate } from '@/lib/format';
import { evidenceSummary } from './inspectorFormat';
import RichSentence from './RichSentence.vue';
import ScoreEvidence from './ScoreEvidence.vue';

/**
 * The Outcome table (RunInspector › 1 Outcome): one row per verification key with its
 * status, score, expected and observed values and the scorer's comment in full. A row whose
 * scorer recorded evidence gets an expander under its comment ("Evidence · 4 of 5 keys
 * match"); a json_match with mismatches opens with it expanded. A scorer `error` row is
 * tinted violet: it is not evidence about the agent. Boards without expected and observed
 * values draw four columns (Key, Status, Score, Comment); so does this table.
 */
const props = defineProps<{ scores: ScoreRowView[] }>();
const emit = defineEmits<{ seek: [seq: number] }>();

const wide = computed(() => props.scores.some((s) => s.expected || s.observed));
const columns = computed(() => (wide.value ? 6 : 4));

const open = ref(new Set<string>());
watch(
  () => props.scores,
  (scores) => {
    open.value = new Set(
      scores.filter((s) => (s.evidence.jsonMatch?.mismatches.length ?? 0) > 0).map((s) => s.key),
    );
  },
  { immediate: true },
);

function toggle(key: string): void {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
}

const summaries = computed(
  () => new Map(props.scores.map((s) => [s.key, evidenceSummary(s.evidence)] as const)),
);
const evidenceId = (key: string): string => `ri-evidence-${key}`;
</script>

<template>
  <div class="overflow-x-auto rounded-6 border border-border bg-surface">
    <table class="dt wrap static" aria-label="Scores">
      <thead>
        <tr>
          <th>Key</th>
          <th>Status</th>
          <th class="text-right">Score</th>
          <template v-if="wide">
            <th>Expected</th>
            <th>Observed</th>
            <th>Scorer comment</th>
          </template>
          <th v-else>Comment</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="score in scores" :key="score.key">
          <tr
            :class="{ '[&>td]:bg-err-soft': score.status === 'error' }"
            :data-key="score.key"
            :data-status="score.status"
            data-testid="score-row"
          >
            <td class="min-w-[180px]">
              <span class="whitespace-nowrap"
                ><span class="font-mono font-semibold">{{ score.key }}</span
                ><template v-if="score.primary">{{ ' ' }}<BaseTag>primary</BaseTag></template></span
              >
              <div class="mt-2 text-12 text-text-3"><RichSentence :text="score.sentence" /></div>
            </td>
            <td>
              <span
                v-if="score.status === 'error'"
                class="chip bg-surface text-err-text inset-ring inset-ring-err"
                data-tone="err"
                >error</span
              >
              <StatusChip v-else kind="score" :status="score.status" :dot="false" />
            </td>
            <td class="text-right font-mono" :class="{ 'text-text-3': score.score === null }">
              {{ score.score === null ? MISSING : formatRate(score.score, 2) }}
            </td>
            <template v-if="wide">
              <td class="font-mono text-12 leading-20 wrap-anywhere">
                <template v-if="score.expected">
                  {{ score.expected.summary }}
                  <div v-if="score.expected.detail" class="whitespace-pre-line text-text-3">
                    {{ score.expected.detail }}
                  </div>
                </template>
                <span v-else class="text-text-3">{{ MISSING }}</span>
              </td>
              <td class="font-mono text-12 leading-20 wrap-anywhere">
                <template v-if="score.observed">
                  {{ score.observed.summary }}
                  <div v-if="score.observed.detail" class="whitespace-pre-line text-text-3">
                    {{ score.observed.detail }}
                  </div>
                </template>
                <span v-else class="text-text-3">{{ MISSING }}</span>
              </td>
            </template>
            <td class="min-w-[200px]" :class="{ 'text-text-2': !wide }">
              <RichSentence :text="score.comment" />
              <div v-if="summaries.get(score.key)" class="mt-4">
                <button
                  type="button"
                  class="inline-flex items-center gap-4 border-0 bg-transparent p-0 text-left text-12 font-medium text-text-2 hover:text-text"
                  :aria-expanded="open.has(score.key)"
                  :aria-controls="evidenceId(score.key)"
                  data-testid="evidence-toggle"
                  @click="toggle(score.key)"
                >
                  <span aria-hidden="true">{{ open.has(score.key) ? '▾' : '▸' }}</span>
                  Evidence · {{ summaries.get(score.key) }}
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="open.has(score.key) && summaries.get(score.key)" :id="evidenceId(score.key)">
            <td :colspan="columns" class="bg-surface-2 px-14 py-10">
              <ScoreEvidence :evidence="score.evidence" @seek="emit('seek', $event)" />
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

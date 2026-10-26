<script setup lang="ts">
import { computed } from 'vue';
import {
  READINESS_RULE_LABELS,
  summariseReadiness,
  type ReadinessRule,
} from '@hermes-evals/shared';
import type { ReadinessRuleResult, ReadinessTarget, TaskReadiness } from '@/api/types/authoring';
import CopyButton from '@/components/ui/CopyButton.vue';
import CodeText from '../editors/CodeText.vue';
import { readinessHead, rowTone } from './readinessText';

/**
 * The task editor's sticky 360px panel (Components 5, ReadinessPanel; SA.8): a status line,
 * then the 13 rules the API checks on every change, each with a Fix link that goes to the
 * field. Problems are violet and dotted, warnings amber, passed rows green, rows waiting on
 * a self-check a grey ring. Answer checks are re-checked live; file checks and scripts need
 * Run self-check, which runs in the worker: running, its transcript when a script errs, and
 * the worker-offline state are drawn on the Self-check row. Problems never block saving.
 *
 * `overrides` replaces rows the editor knows better right now (a file refused before upload
 * is a file-limits problem the API never saw).
 */
const props = withDefaults(
  defineProps<{
    readiness: TaskReadiness;
    /** "overdue_count · draft · saved 16:31". */
    taskLabel: string;
    selfCheckState?: 'idle' | 'running' | 'offline' | 'failed';
    selfCheckError?: string | null;
    /** Checks the worker runs: "Running 2 checks…". */
    workerChecks?: number;
    /** The command and output of a script that erred in the last self-check. */
    transcript?: string | null;
    overrides?: Partial<Record<ReadinessRule, ReadinessRuleResult>>;
    /** No Run self-check while the form is locked. */
    readonly?: boolean;
  }>(),
  {
    selfCheckState: 'idle',
    selfCheckError: null,
    workerChecks: 0,
    transcript: null,
    overrides: () => ({}),
    readonly: false,
  },
);
const emit = defineEmits<{ fix: [target: ReadinessTarget]; runSelfCheck: [] }>();

const OFFLINE =
  "The worker isn't running, so file checks and scripts can't be self-checked. Your draft is kept.";

const rows = computed(() =>
  props.readiness.rules.map((rule) => {
    const row = props.overrides[rule.rule] ?? rule;
    if (row.rule === 'self_check' && props.selfCheckState === 'offline')
      return { ...row, status: 'pending' as const, message: OFFLINE };
    return row;
  }),
);
const running = computed(() => props.selfCheckState === 'running');
const head = computed(() => readinessHead(summariseReadiness(rows.value).counts, running.value));

function extra(row: ReadinessRuleResult): 'button' | 'spin' | 'transcript' | 'command' | null {
  if (row.rule !== 'self_check') return null;
  if (running.value) return 'spin';
  if (props.selfCheckState === 'offline') return 'command';
  if (row.status === 'problem' && props.transcript) return 'transcript';
  if (row.status === 'pending' && props.readiness.needsWorker && !props.readonly) return 'button';
  return null;
}
</script>

<template>
  <aside
    aria-labelledby="rp-h"
    class="flex flex-col rounded-6 border border-border bg-surface"
    data-testid="readiness-panel"
  >
    <div
      class="flex flex-col gap-6 rounded-t-6 border-b border-border px-14 py-12"
      :class="head.background"
      data-testid="readiness-head"
    >
      <div class="flex items-center justify-between gap-8">
        <span class="text-12 font-semibold text-text-2">Readiness</span>
        <span class="truncate font-mono text-12 text-text-3">{{ taskLabel }}</span>
      </div>
      <h2 id="rp-h" class="m-0 flex flex-wrap items-center gap-8 text-15 font-semibold">
        <span :class="head.icon" aria-hidden="true" />
        <span v-for="(part, i) in head.parts" :key="i" :class="part.tone">{{ part.text }}</span>
      </h2>
    </div>
    <ol class="m-0 flex list-none flex-col p-0 py-4">
      <li
        v-for="row in rows"
        :key="row.rule"
        class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-8 px-14 py-7"
        :class="rowTone(row.status).row"
        :data-rule="row.rule"
        :data-status="row.status"
      >
        <span class="mt-2 inline-flex size-16 items-center justify-center">
          <svg
            v-if="row.status === 'passed'"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-pass"
            role="img"
            aria-label="Passed"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <svg
            v-else-if="row.status === 'warning'"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            stroke-width="2.25"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="fill-ung-soft stroke-ung"
            role="img"
            aria-label="Warning"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          <span
            v-else-if="row.status === 'problem'"
            class="inline-block size-14 rounded-full border-2 border-dotted border-err bg-err-soft"
            aria-label="Problem"
            role="img"
          />
          <span
            v-else
            class="inline-block size-13 rounded-full border-[1.5px] border-que"
            aria-label="Not run"
            role="img"
          />
        </span>
        <div class="flex min-w-0 flex-col gap-2">
          <span
            class="text-12 leading-18"
            :class="row.status === 'passed' ? 'text-text-2' : 'font-medium text-text'"
            ><CodeText :text="READINESS_RULE_LABELS[row.rule]"
          /></span>
          <span
            v-if="row.message"
            class="text-12 leading-18"
            :class="rowTone(row.status).message"
            data-testid="rule-message"
            ><CodeText :text="row.message"
          /></span>
          <span v-if="extra(row) === 'button'" class="mt-4">
            <button
              type="button"
              class="btn sm primary"
              data-testid="run-self-check"
              @click="emit('runSelfCheck')"
            >
              Run self-check
            </button>
          </span>
          <span
            v-if="row.rule === 'self_check' && selfCheckState === 'failed' && selfCheckError"
            role="alert"
            class="text-12 leading-18 text-fail-text"
            >{{ selfCheckError }}</span
          >
          <span
            v-if="extra(row) === 'spin'"
            class="mt-2 inline-flex items-center gap-8 text-12 text-run-text"
            role="status"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" class="animate-spin" aria-hidden="true">
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-dasharray="28 10"
              />
            </svg>
            Running {{ workerChecks }} {{ workerChecks === 1 ? 'check' : 'checks' }}…
          </span>
          <pre
            v-if="extra(row) === 'transcript'"
            class="mt-4 rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-11 leading-16 whitespace-pre-wrap"
            data-testid="self-check-transcript"
            >{{ transcript }}</pre>
          <span
            v-if="extra(row) === 'command'"
            class="mt-4 inline-flex items-center gap-6 self-start rounded-4 border border-border bg-surface-2 py-3 pr-4 pl-8"
            ><code>docker compose up -d worker</code
            ><CopyButton text="docker compose up -d worker" label="Copy command"
          /></span>
        </div>
        <button
          v-if="(row.status === 'problem' || row.status === 'warning') && row.target"
          type="button"
          class="linkbtn text-12 leading-18"
          :aria-label="`Fix: ${READINESS_RULE_LABELS[row.rule].replace(/`/g, '')}`"
          @click="emit('fix', row.target)"
        >
          Fix
        </button>
      </li>
    </ol>
    <p class="m-0 border-t border-border px-14 pt-10 pb-12 text-12 text-text-3">
      Problems don't block saving. A task with problems is saved as invalid and can't be launched
      until it's fixed.
    </p>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SelfCheckFailureView, TaskDetail } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import { formatDateTime, formatSha256, plural } from '@/lib/format';
import ZoneLabel from './ZoneLabel.vue';

/**
 * The task's verifier script (TaskDetail board, Flow D step 4): its path, hash and source
 * with line numbers. When the last self-check failed inside the script, the line its
 * traceback names is marked, the source opens around it, and the error is quoted under it.
 * Without a verifier_script check it says so, with the contract every script keeps.
 */
const props = withDefaults(
  defineProps<{
    verifier: TaskDetail['verifier'];
    failure?: SelfCheckFailureView | null;
  }>(),
  { failure: null },
);

/** Lines shown before and after the marked line until "Show all" is pressed. */
const CONTEXT = 10;
const showAll = ref(false);

const lines = computed(() => {
  const source = props.verifier?.source.replace(/\n$/, '') ?? '';
  return source === '' ? [] : source.split('\n');
});

/** The line of the script the failure's traceback names, and the error it raised. */
const mark = computed<{ line: number; error: string | null } | null>(() => {
  const v = props.verifier;
  const f = props.failure;
  if (!v || !f || f.type !== 'verifier_script') return null;
  const name = v.path.split('/').pop() ?? v.path;
  let line: number | null = null;
  for (const m of f.transcript.matchAll(/File "([^"]+)", line (\d+)/g)) {
    if (m[1]!.endsWith(name)) line = Number(m[2]);
  }
  if (line === null || line > lines.value.length) return null;
  const error = /^(\w+(?:Error|Exception)\b.*)$/m.exec(f.transcript)?.[1] ?? null;
  return { line, error };
});

const range = computed(() => {
  const total = lines.value.length;
  if (!mark.value || showAll.value) return { from: 1, to: total };
  return {
    from: Math.max(1, mark.value.line - CONTEXT),
    to: Math.min(total, mark.value.line + CONTEXT),
  };
});
const shown = computed(() =>
  lines.value
    .slice(range.value.from - 1, range.value.to)
    .map((text, i) => ({ n: range.value.from + i, text })),
);
const partial = computed(() => range.value.from > 1 || range.value.to < lines.value.length);
</script>

<template>
  <BasePanel aria-labelledby="task-verifier" clip>
    <template #header>
      <div
        class="flex flex-wrap items-center justify-between gap-10 border-b border-border px-16 py-12"
      >
        <span class="flex flex-wrap items-center gap-10">
          <h2 id="task-verifier" class="text-15 font-semibold">Verifier script</h2>
          <ZoneLabel zone="hidden" />
          <span class="text-12 text-text-3">runs in the worker</span>
        </span>
        <span v-if="verifier" class="inline-flex flex-wrap items-center gap-6">
          <code>{{ verifier.path }}</code>
          <span class="tag" :title="verifier.sha256">{{ formatSha256(verifier.sha256) }}</span>
          <span class="text-12 text-text-3">{{ plural(lines.length, 'line') }}</span>
          <CopyButton
            :text="verifier.path"
            variant="button"
            button-text="Copy path"
            :label="`Copy path ${verifier.path}`"
          />
        </span>
      </div>
    </template>
    <div v-if="!verifier" class="flex flex-col gap-8 px-16 py-12">
      <p class="text-text-2">
        None. This task's checks use built-in types only. Tasks with a
        <span class="font-mono">verifier_script</span> check show its source here, with its path
        under <code>verify/</code> and its hash.
      </p>
      <p class="text-12 text-text-3">
        Contract for every verifier script: the platform runs
        <code
          >python3 verify/&lt;script&gt; --answer &lt;answer.json&gt; --workspace &lt;dir&gt;</code
        >
        in the script's folder. The last line it prints must be JSON
        <code>{"score": 0.0–1.0, "comment": "…"}</code>. A non-zero exit, a timeout or a missing
        line is error.
      </p>
      <p class="text-12 text-text-3">Verifier scripts are edited on disk.</p>
    </div>
    <div v-else class="flex flex-col gap-8 px-16 py-12">
      <span class="flex flex-wrap items-center gap-8 text-12 text-text-3">
        <span
          >Verifier scripts are edited on disk.<template v-if="partial || mark">
            Lines {{ range.from }}–{{ range.to }} of {{ lines.length }}</template
          ><template v-if="mark">
            · the marked line raised the error in the last self-check</template
          ></span
        >
        <button v-if="partial" type="button" class="linkbtn text-12" @click="showAll = true">
          Show all {{ lines.length }} lines
        </button>
      </span>
      <div
        class="overflow-x-auto rounded-4 border border-border bg-surface-2 font-mono text-12 leading-20"
        role="region"
        :aria-label="`Source of ${verifier.path}`"
        tabindex="0"
      >
        <div
          v-for="l in shown"
          :key="l.n"
          class="grid grid-cols-[44px_minmax(0,1fr)] whitespace-pre"
          :class="{ 'bg-fail-soft shadow-[inset_3px_0_0_var(--fail)]': mark?.line === l.n }"
          :data-line="l.n"
          :data-marked="mark?.line === l.n ? 'true' : undefined"
        >
          <span
            class="pr-12 text-right text-text-3 select-none"
            :class="{ 'font-semibold text-fail-text': mark?.line === l.n }"
            >{{ l.n }}</span
          >
          <span>{{ l.text || ' ' }}</span>
        </div>
      </div>
      <div
        v-if="mark && failure"
        role="note"
        class="flex items-start gap-8 rounded-4 border border-fail bg-fail-soft px-10 py-8"
      >
        <span class="font-mono text-12 font-semibold text-fail-text">{{ mark.line }}</span>
        <span class="text-12 leading-18"
          ><b v-if="mark.error" class="text-fail-text">{{ mark.error }}</b>
          <span class="text-text-2">
            on the reference answer, self-check {{ formatDateTime(failure.ranAt) }}.</span
          ></span
        >
      </div>
      <p class="text-12 text-text-3">
        Runs
        <code
          >python3 {{ verifier.path }} --answer &lt;answer.json&gt; --workspace &lt;dir&gt;</code
        >
        in the script's folder. The last line it prints must be JSON
        <code>{"score": 0.0–1.0, "comment": "…"}</code>. A non-zero exit, a timeout or a missing
        line is error.
      </p>
    </div>
  </BasePanel>
</template>

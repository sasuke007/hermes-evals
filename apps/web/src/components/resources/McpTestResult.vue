<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { McpTestView } from '@/api/types/resources';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { ROUTE_NAMES } from '@/router';
import { plural } from '@/lib/format';

/**
 * What Test start found (ResourcesMcp board, Library states › test start failed): how fast the
 * server started and which tools it exposes, ✓ on the ones the filter offers; or why it did
 * not start, with its stderr and, when a variable has no value, where to set it. `unsaved`:
 * the definition tested is not stored, so the result is not recorded on any row.
 */
const props = withDefaults(
  defineProps<{ result: McpTestView; transport: 'stdio' | 'http'; unsaved?: boolean }>(),
  { unsaved: false },
);

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const passed = computed(() => {
  const r = props.result;
  if (r.status !== 'passed') return null;
  const included = r.tools.filter((t) => t.included).length;
  const share = included === r.tools.length ? 'all included' : `${included} included`;
  const start =
    props.transport === 'http'
      ? `Connected through egress in ${seconds(r.startedMs)}`
      : `Started in ${seconds(r.startedMs)}`;
  return {
    lead: `${start} · exposes ${plural(r.tools.length, 'tool')} · ${share}`,
    excluded: included < r.tools.length,
  };
});
const missing = computed(() =>
  props.result.status === 'failed' ? props.result.missingSecretNames : [],
);
const where = computed(() =>
  props.transport === 'http' ? 'the egress environment' : 'the worker environment',
);
const secretsLink = { name: ROUTE_NAMES.resourcesTab, params: { tab: 'secrets' } };
</script>

<template>
  <div
    v-if="result.status === 'passed' && passed"
    class="flex flex-col gap-6 rounded-6 border border-pass bg-pass-soft px-12 py-10"
    role="status"
    data-testid="mcp-test-result"
    data-status="passed"
  >
    <b class="text-pass-text">{{ passed.lead }}</b>
    <div class="flex flex-wrap gap-6">
      <span
        v-for="tool in result.tools"
        :key="tool.name"
        class="tag"
        :class="{ 'border-pass text-text': tool.included }"
        :title="tool.description ?? undefined"
        :data-included="tool.included"
        >{{ tool.name }}{{ tool.included ? ' ✓' : '' }}</span
      >
    </div>
    <span v-if="passed.excluded" class="text-12 text-text-3"
      >The excluded tools will not be offered to the agent.</span
    >
  </div>

  <div v-else-if="result.status === 'failed'" class="flex flex-col gap-10">
    <div
      class="flex flex-col gap-6 rounded-6 border border-fail bg-fail-soft px-12 py-10"
      role="alert"
      data-testid="mcp-test-result"
      data-status="failed"
    >
      <b class="text-fail-text">{{ result.error }}</b>
      <CodeBlock v-if="result.stderrTail" :code="result.stderrTail" plain label="stderr" />
      <span v-if="missing.length" class="text-12 leading-20 text-text-2">
        {{
          missing.length === 1
            ? `The variable name is declared, but ${where} has no value for it.`
            : `The variable names ${missing.join(', ')} are declared, but ${where} has no value for them.`
        }}
        <RouterLink :to="secretsLink">Resources › Secrets</RouterLink> shows
        {{ missing.length === 1 ? 'it' : 'them' }} as <b>not set</b> and explains how to add
        {{ missing.length === 1 ? 'it' : 'them' }}; then test again.
      </span>
    </div>
    <p v-if="unsaved" class="text-12 text-text-3">
      Saving is still allowed, because the server may only work inside a full run. The row then
      carries an "untested" tag.
    </p>
  </div>

  <div
    v-else-if="result.status === 'running'"
    class="flex items-start gap-8 rounded-6 border border-border-strong bg-accent-soft px-12 py-10 text-text-2"
    role="status"
    data-testid="mcp-test-result"
    data-status="running"
  >
    <span
      class="mt-4 size-12 flex-none animate-spin rounded-full border-[1.5px] border-accent border-r-transparent"
      aria-hidden="true"
    />
    <span v-if="unsaved"
      ><b class="text-text">Still starting.</b> The API stopped waiting before the server answered,
      and a test of an unsaved definition is not recorded. Test start again in a moment.</span
    >
    <span v-else
      ><b class="text-text">Still starting.</b> The API stopped waiting before the server answered;
      the result appears here when the test ends.</span
    >
  </div>
</template>

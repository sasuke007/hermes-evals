<script setup lang="ts">
import { computed } from 'vue';
import CopyButton from '@/components/ui/CopyButton.vue';
import { formatBytes, formatSha256 } from '@/lib/format';

/**
 * A verifier script, read-only (SA.6, SA.7): its path, size and hash, "read-only here",
 * Copy path, the source with line numbers, and the contract the platform runs it under.
 * Scripts are edited on disk; nothing here can change one (plan 4.6, V6).
 */
const props = withDefaults(
  defineProps<{
    file: { path: string; sizeBytes: number; sha256: string };
    source: string | null;
    error?: string | null;
  }>(),
  { error: null },
);
const lines = computed(() => (props.source ?? '').replace(/\n$/, '').split('\n'));
</script>

<template>
  <div
    class="overflow-hidden rounded-6 border border-border bg-surface"
    data-testid="script-source"
  >
    <div
      class="flex flex-wrap items-center justify-between gap-8 border-b border-border px-12 py-8"
    >
      <span class="inline-flex min-w-0 flex-wrap items-center gap-8"
        ><code class="font-semibold">{{ file.path }}</code
        ><span class="text-12 text-text-3">{{ formatBytes(file.sizeBytes) }}</span
        ><span class="tag" :title="file.sha256">{{ formatSha256(file.sha256) }}</span
        ><span class="tag">read-only here</span></span
      >
      <CopyButton :text="file.path" variant="button" label="Copy path" button-text="Copy path" />
    </div>
    <div v-if="error" role="alert" class="px-12 py-8 text-12 text-fail-text">{{ error }}</div>
    <div
      v-else-if="source === null"
      class="flex flex-col gap-6 px-12 py-10"
      aria-busy="true"
      data-testid="script-loading"
    >
      <span class="h-10 w-260 animate-shimmer rounded-3 bg-surface-3" />
      <span class="h-10 w-200 animate-shimmer rounded-3 bg-surface-3" />
    </div>
    <div v-else class="max-h-360 overflow-auto bg-surface-2 py-6 font-mono text-12 leading-20">
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="grid grid-cols-[44px_minmax(0,1fr)] whitespace-pre"
      >
        <span class="pr-12 text-right text-text-3 select-none">{{ i + 1 }}</span
        ><span>{{ line }}</span>
      </div>
    </div>
    <div class="flex flex-col gap-4 border-t border-border px-12 py-10">
      <b class="text-12">Verifier scripts are edited on disk.</b>
      <span class="text-12 leading-18 text-text-2"
        >Runs
        <code>python3 {{ file.path }} --answer &lt;answer.json&gt; --workspace &lt;dir&gt;</code> in
        the script's folder. The last line it prints must be JSON
        <code>{"score": 0.0–1.0, "comment": "…"}</code>. A non-zero exit, a timeout or a missing
        line is error.</span
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DraftWrite } from '@/api/types/authoring';
import { formatBytes, plural } from '@/lib/format';

/**
 * "What is written" on Review and save (SA.11): each file the save adds (+) or changes (~)
 * and each task folder it removes (−), with sizes, under a one-line count. Files the UI does
 * not manage are kept as they are and not listed.
 */
const props = defineProps<{
  writes: DraftWrite[];
  /** As shown: `./suites/invoices-v1/`. */
  folderPath: string;
}>();

const SIGN: Record<DraftWrite['op'], { text: string; tone: string }> = {
  add: { text: '+', tone: 'text-pass-text' },
  change: { text: '~', tone: 'text-run-text' },
  remove: { text: '−', tone: 'text-fail-text' },
};

const removed = computed(() => props.writes.filter((w) => w.op === 'remove'));
const written = computed(() => props.writes.length - removed.value.length);
const removes = computed(() =>
  removed.value.length === 0 ? 'nothing' : plural(removed.value.length, 'task folder'),
);

function size(w: DraftWrite): string {
  if (w.note && (w.op === 'remove' || w.path.endsWith('suite.yaml'))) return w.note;
  if (w.beforeBytes !== null && w.afterBytes !== null)
    return `${formatBytes(w.beforeBytes)} → ${formatBytes(w.afterBytes)}`;
  return formatBytes(w.afterBytes ?? w.beforeBytes);
}
</script>

<template>
  <section
    class="rounded-6 border border-border bg-surface"
    aria-labelledby="save-writes"
    data-testid="draft-writes"
  >
    <div class="flex items-center justify-between gap-10 border-b border-border px-16 py-12">
      <h2 id="save-writes" class="text-15 font-semibold">What is written</h2>
      <span class="text-12 text-text-3" data-testid="writes-caption"
        >Writes {{ plural(written, 'file') }} to <code>{{ folderPath }}</code> and removes
        {{ removes }}.</span
      >
    </div>
    <table class="dt static" aria-label="Files written">
      <tbody>
        <tr v-for="w in writes" :key="`${w.op}:${w.path}`" :data-op="w.op">
          <td class="w-30 font-mono font-semibold" :class="SIGN[w.op].tone">
            <span :aria-label="w.op">{{ SIGN[w.op].text }}</span>
          </td>
          <td class="font-mono text-12">{{ w.path }}</td>
          <td class="text-12 text-text-2">{{ size(w) }}</td>
        </tr>
      </tbody>
    </table>
    <p class="border-t border-border px-16 py-8 text-12 text-text-3">
      Files the UI doesn't manage (a README, <code>verify/</code> scripts) are kept exactly as they
      are.
    </p>
  </section>
</template>

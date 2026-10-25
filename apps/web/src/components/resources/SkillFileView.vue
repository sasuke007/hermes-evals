<script setup lang="ts">
import { computed } from 'vue';
import type { SkillFileContent } from '@/api/types/resources';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { formatBytes, formatSha256 } from '@/lib/format';
import { parseCsv } from './markdown';
import MarkdownView from './MarkdownView.vue';

/**
 * One file of a skill in the detail drawer: Markdown rendered, code and text as written, CSV
 * as a table, and a binary file (or one too large to send) as its size and hash only.
 */
const props = defineProps<{ file: SkillFileContent }>();

/** Rows a CSV preview shows; the rest are counted. */
const CSV_ROWS = 50;
const csv = computed(() => {
  if (props.file.kind !== 'csv' || props.file.content === null) return null;
  const rows = parseCsv(props.file.content, CSV_ROWS + 1);
  const [head = [], ...body] = rows;
  return { head, body: body.slice(0, CSV_ROWS), more: body.length > CSV_ROWS };
});
</script>

<template>
  <div class="flex min-w-0 flex-col gap-12" data-testid="skill-file">
    <span class="font-mono font-semibold">{{ file.path }}</span>
    <dl
      v-if="file.content === null"
      class="grid grid-cols-[80px_minmax(0,1fr)] gap-x-12 gap-y-6"
      data-testid="binary-file"
    >
      <dt class="text-text-2">Size</dt>
      <dd>{{ formatBytes(file.sizeBytes) }}</dd>
      <dt class="text-text-2">Hash</dt>
      <dd class="font-mono text-12 leading-20" :title="`sha256:${file.sha256}`">
        {{ formatSha256(file.sha256, 12) }}
      </dd>
    </dl>
    <MarkdownView v-else-if="file.kind === 'markdown'" :source="file.content" />
    <div v-else-if="csv" class="flex flex-col gap-8">
      <div class="tbl">
        <table class="dt th30 static" :aria-label="file.path">
          <thead>
            <tr>
              <th v-for="(cell, i) in csv.head" :key="i" class="font-mono">{{ cell }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in csv.body" :key="r">
              <td v-for="(cell, c) in row" :key="c" class="font-mono text-12">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="csv.more" class="text-12 text-text-3">The first {{ CSV_ROWS }} rows.</p>
    </div>
    <CodeBlock v-else :code="file.content" :label="file.path" />
  </div>
</template>

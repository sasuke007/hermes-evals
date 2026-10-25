<script setup lang="ts">
import { computed } from 'vue';

/**
 * prompt.md as TaskDetail shows it (exactly what the agent receives, not rendered as
 * Markdown): paragraphs split on blank lines, `inline code` in code, and fenced blocks kept
 * as written in a code box.
 */
const props = defineProps<{ markdown: string }>();

type Block =
  { kind: 'text'; parts: { text: string; code: boolean }[] } | { kind: 'code'; text: string };

/** Paragraphs and fenced blocks, in order. */
function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = (): void => {
    const text = paragraph.join('\n').trim();
    if (text) {
      blocks.push({
        kind: 'text',
        parts: text
          .split('`')
          .map((t, i) => ({ text: t, code: i % 2 === 1 }))
          .filter((p) => p.text !== ''),
      });
    }
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      flush();
      const fence = [line];
      while (i + 1 < lines.length) {
        i += 1;
        fence.push(lines[i]!);
        if (lines[i]!.trimStart().startsWith('```')) break;
      }
      blocks.push({ kind: 'code', text: fence.join('\n') });
    } else if (line.trim() === '') {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

const blocks = computed(() => blocksOf(props.markdown));
</script>

<template>
  <div class="flex max-w-760 flex-col gap-10 leading-22" data-testid="prompt">
    <template v-for="(block, i) in blocks" :key="i">
      <p v-if="block.kind === 'text'" class="whitespace-pre-line">
        <template v-for="(part, j) in block.parts" :key="j">
          <code v-if="part.code" class="rounded-3 bg-surface-2 px-4 py-1 font-mono text-12">{{
            part.text
          }}</code>
          <template v-else>{{ part.text }}</template>
        </template>
      </p>
      <pre
        v-else
        class="rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
        >{{ block.text }}</pre>
    </template>
  </div>
</template>

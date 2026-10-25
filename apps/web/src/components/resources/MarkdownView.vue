<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { parseMarkdown } from './markdown';
import MarkdownInline from './MarkdownInline.vue';

/**
 * A skill's Markdown as the skill drawer draws SKILL.md: a 17px heading, body paragraphs,
 * lists 20px in, inline code in mono. Rendered from parsed blocks (markdown.ts), never as
 * HTML.
 */
const props = defineProps<{ source: string }>();

const blocks = computed(() => parseMarkdown(props.source));
const HEADING_CLASS: Record<number, string> = {
  1: 'text-17 font-semibold',
  2: 'text-15 font-semibold',
};
</script>

<template>
  <div class="flex max-w-720 flex-col gap-12" data-testid="markdown">
    <template v-for="(block, i) in blocks" :key="i">
      <component
        :is="`h${Math.min(block.level + 2, 6)}`"
        v-if="block.kind === 'heading'"
        :class="HEADING_CLASS[block.level] ?? 'font-semibold'"
        ><MarkdownInline :inline="block.inline"
      /></component>
      <p v-else-if="block.kind === 'paragraph'"><MarkdownInline :inline="block.inline" /></p>
      <ol
        v-else-if="block.kind === 'list' && block.ordered"
        :start="block.start"
        class="flex list-decimal flex-col gap-4 pl-20"
      >
        <li v-for="(item, j) in block.items" :key="j"><MarkdownInline :inline="item" /></li>
      </ol>
      <ul v-else-if="block.kind === 'list'" class="flex list-disc flex-col gap-4 pl-20">
        <li v-for="(item, j) in block.items" :key="j"><MarkdownInline :inline="item" /></li>
      </ul>
      <CodeBlock v-else-if="block.kind === 'code'" :code="block.text" size="sm" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { segmentText, type TextRange } from '@/lib/textSegments';

/**
 * Text set verbatim in mono with the part that matters marked (Components 2 › JsonBlock):
 * the agent's final response with the fenced block the scorer used highlighted under an
 * "extracted" label at its top edge, other blocks dimmed as "ignored", and the character
 * where JSON parsing stopped underlined. Pass `value` instead of `text` for a JSON value
 * pretty-printed (a reference answer, a launch record field).
 * The parsed-answer pane beside it is the page's; this draws the text.
 */
const props = withDefaults(
  defineProps<{
    /** The text, verbatim. */
    text?: string | null;
    /** A JSON value, pretty-printed with two spaces; used when `text` is not given. */
    value?: unknown;
    /** The range to highlight: FinalResponseView.fence. */
    highlight?: TextRange | null;
    highlightLabel?: string;
    /** Other ranges, dimmed: the blocks the scorer did not use. */
    ignored?: TextRange[];
    ignoredLabel?: string;
    /** Absolute offset of the character where parsing stopped. */
    errorAt?: number | null;
    /** false: no panel border and padding (inside an existing box). */
    panel?: boolean;
    /** Max height in px before it scrolls. */
    maxHeight?: number | null;
    /** Accessible name of the block. */
    label?: string | null;
  }>(),
  {
    text: null,
    value: undefined,
    highlight: null,
    highlightLabel: 'extracted',
    ignored: () => [],
    ignoredLabel: 'ignored',
    errorAt: null,
    panel: true,
    maxHeight: null,
    label: null,
  },
);

const source = computed(() => {
  if (props.text !== null) return props.text;
  if (props.value === undefined) return '';
  return JSON.stringify(props.value, null, 2) ?? String(props.value);
});
const segments = computed(() =>
  segmentText(source.value, props.highlight, props.ignored, props.errorAt),
);

const LABEL =
  'absolute -top-9 right-8 rounded-3 px-5 font-sans text-[10px] leading-16 font-semibold select-none';
</script>

<template>
  <pre
    class="overflow-auto font-mono text-12 leading-19 whitespace-pre-wrap"
    :class="{ 'rounded-6 border border-border bg-surface p-14': panel }"
    :style="maxHeight ? { maxHeight: `${maxHeight}px` } : undefined"
    :aria-label="label ?? undefined"
    data-testid="json-block"
  ><template v-for="(segment, i) in segments" :key="i"><span
    v-if="segment.kind === 'highlight'"
    class="relative mt-8 block rounded-4 bg-accent-soft px-10 py-8 inset-ring inset-ring-accent"
    data-testid="json-highlight"
  ><span :class="[LABEL, 'bg-accent text-on-accent']" aria-hidden="true">{{ highlightLabel }}</span><template v-for="(part, j) in segment.parts" :key="j"><span v-if="part.error" class="bg-fail-soft font-semibold text-fail-text underline decoration-fail decoration-wavy underline-offset-3" data-testid="json-error">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></span><span
    v-else-if="segment.kind === 'ignored'"
    class="relative mt-8 mb-4 block rounded-4 border border-dashed border-border-strong px-10 py-8 opacity-50"
    data-testid="json-ignored"
  ><span :class="[LABEL, 'bg-surface-3 text-text-2']" aria-hidden="true">{{ ignoredLabel }}</span><template v-for="(part, j) in segment.parts" :key="j">{{ part.text }}</template></span><template v-else><template v-for="(part, j) in segment.parts" :key="j"><span v-if="part.error" class="bg-fail-soft font-semibold text-fail-text underline decoration-fail decoration-wavy underline-offset-3" data-testid="json-error">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></template></template></pre>
</template>

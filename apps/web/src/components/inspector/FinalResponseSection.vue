<script setup lang="ts">
import { computed } from 'vue';
import JsonBlock from '@/components/ui/JsonBlock.vue';
import type { RunDetail } from '@/api/types/runs';
import { formatCount } from '@/lib/format';
import RichSentence from './RichSentence.vue';
import SectionHeading from './SectionHeading.vue';
import { answerTree, jsonFences, lineColumn } from './inspectorFormat';

/**
 * Section 3, Final response (RunInspector; Components 2 › JsonBlock states): the text Hermes
 * recorded, verbatim, with the fenced block the scorer parsed highlighted as "extracted"; the
 * parsed answer beside it, and under it the reference answer, which the agent never saw.
 * No block: an amber line says so and nothing is highlighted. Invalid JSON: the character
 * where parsing stopped is marked and named. Several blocks: the others are dimmed as
 * "ignored", since the scorer uses the last one.
 */
const props = defineProps<{ detail: RunDetail; sectionId: string }>();

const final = computed(() => props.detail.finalResponse);
const fences = computed(() => (final.value ? jsonFences(final.value.text) : []));
const ignored = computed(() => {
  const used = final.value?.fence;
  if (!used || fences.value.length < 2) return [];
  return fences.value.filter((f) => f.start !== used.start);
});
const blockIndex = computed(() => {
  const used = final.value?.fence;
  const at = used ? fences.value.findIndex((f) => f.start === used.start) : -1;
  return at >= 0 ? at + 1 : fences.value.length;
});
const errorAt = computed(() => final.value?.parseError?.position ?? null);
/** Extraction only speaks for a run that is being or was scored (an execution error was not). */
const graded = computed(() => ['executed', 'scoring', 'scored'].includes(props.detail.status));
const empty = computed(() => (final.value?.text.trim() ?? '') === '');
const errorPlace = computed(() => {
  const f = final.value;
  if (!f || errorAt.value === null) return null;
  const { line, column } = lineColumn(f.text, errorAt.value);
  return { line, column, char: errorAt.value };
});
const parsedTree = computed(() =>
  final.value?.parsed !== null && final.value?.parsed !== undefined
    ? answerTree(final.value.parsed)
    : [],
);
const referenceTree = computed(() => (final.value ? answerTree(final.value.reference) : []));

const absentText = computed(() => {
  switch (props.detail.status) {
    case 'queued':
    case 'running':
      return 'No final response yet: the run has not finished.';
    case 'cancelled':
      return 'No final response: the run was cancelled before Hermes wrote one.';
    case 'execution_error':
      return 'No final response: the run stopped before Hermes wrote one.';
    default:
      return 'No final response was recorded for this attempt.';
  }
});
</script>

<template>
  <section
    :id="sectionId"
    aria-labelledby="ri-h-final"
    class="flex flex-col gap-10"
    data-testid="section-final"
  >
    <SectionHeading id="ri-h-final" :n="3" title="Final response" />
    <template v-if="final">
      <div
        v-if="graded && final.extraction === 'missing'"
        role="status"
        class="flex items-center gap-8 rounded-4 border border-ung bg-ung-soft px-10 py-6"
        data-testid="extraction-banner"
      >
        <span class="size-7 flex-none rounded-full border-[1.5px] border-ung" aria-hidden="true" />
        <b class="text-12 text-ung-text">No fenced JSON block found · score status ungradable</b>
      </div>
      <div
        v-else-if="graded && final.extraction === 'invalid'"
        role="status"
        class="flex items-center gap-8 rounded-4 border border-ung bg-ung-soft px-10 py-6"
        data-testid="extraction-banner"
      >
        <span class="size-7 flex-none rounded-full border-[1.5px] border-ung" aria-hidden="true" />
        <b class="text-12 text-ung-text"
          >Invalid JSON in the extracted block<template v-if="errorPlace">
            · line {{ errorPlace.line }}, column {{ errorPlace.column }}</template
          >
          · score status ungradable</b
        >
      </div>
      <div
        v-else-if="fences.length > 1"
        role="status"
        class="flex items-center gap-8 rounded-4 border border-border bg-surface-2 px-10 py-6"
        data-testid="extraction-banner"
      >
        <span class="size-6 flex-none rounded-full bg-text-3" aria-hidden="true" />
        <b class="text-12 text-text-2"
          >{{ fences.length }} blocks found · the
          {{ blockIndex === fences.length ? 'last one' : `block ${blockIndex}` }} is used</b
        >
      </div>
      <div class="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-12 max-lg:grid-cols-1">
        <div
          v-if="empty"
          class="rounded-6 border border-border bg-surface p-14 text-12 text-text-3"
          data-testid="final-empty"
        >
          Hermes recorded an empty final response.
        </div>
        <JsonBlock
          v-else
          :text="final.text"
          :highlight="final.fence"
          :ignored="ignored"
          :error-at="errorAt"
          label="Final response"
        />
        <div
          class="flex flex-col gap-6 rounded-6 border border-border bg-surface p-14"
          data-testid="parsed-answer"
        >
          <div class="text-12 text-text-3">
            Parsed answer<template v-if="fences.length > 1">
              · block {{ blockIndex }} of {{ fences.length }}</template
            >
          </div>
          <div v-if="parsedTree.length" class="flex flex-col gap-2 font-mono text-12 leading-18">
            <template v-for="(line, i) in parsedTree" :key="i">
              <div>
                <template v-if="line.key !== null"
                  ><span class="text-accent">{{ line.key }}</span
                  >: </template
                ><span class="text-text-2">{{ line.summary }}</span>
              </div>
              <div v-for="(item, j) in line.items" :key="j" class="pl-14 text-text-2">
                {{ item }}
              </div>
            </template>
          </div>
          <div v-else-if="final.parseError" class="text-12 leading-18">
            <b class="text-fail-text">
              Parse error<template v-if="errorPlace">
                at line {{ errorPlace.line }}, column {{ errorPlace.column }} (char
                {{ formatCount(errorPlace.char) }})</template
              ></b
            >
            <div class="font-mono text-text-2">{{ final.parseError.message }}</div>
          </div>
          <div v-else class="text-12 text-text-3">
            Nothing parsed. The scorer needs a fenced <RichSentence text="```json" /> block.
          </div>
          <div class="my-8 h-1 bg-border" />
          <div class="flex items-center gap-6 text-12 text-text-3">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M1.5 6s1.8-3.5 4.5-3.5S10.5 6 10.5 6 8.7 9.5 6 9.5 1.5 6 1.5 6z M2 10L10 2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
              /></svg
            >Reference answer · hidden from the agent
          </div>
          <div
            class="flex flex-col gap-2 font-mono text-12 leading-18"
            data-testid="reference-answer"
          >
            <template v-for="(line, i) in referenceTree" :key="i">
              <div>
                <template v-if="line.key !== null"
                  ><span class="text-accent">{{ line.key }}</span
                  >: </template
                ><span class="text-text-2">{{ line.summary }}</span>
              </div>
              <div v-for="(item, j) in line.items" :key="j" class="pl-14 text-text-2">
                {{ item }}
              </div>
            </template>
          </div>
          <p v-if="final.referenceNote" class="mt-6 text-12 text-text-3">
            {{ final.referenceNote }}
          </p>
        </div>
      </div>
    </template>
    <div
      v-else
      class="rounded-6 border border-border bg-surface px-14 py-12 text-text-2"
      data-testid="final-absent"
    >
      {{ absentText }}
    </div>
  </section>
</template>

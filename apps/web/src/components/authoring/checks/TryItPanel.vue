<script setup lang="ts">
import { computed, useId } from 'vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { TryState } from '@/stores/draftTaskTools';
import CodeText from '../editors/CodeText.vue';
import NoteIcon from '../editors/NoteIcon.vue';
import { compact, detailRows, referenceLine, resultLine } from './tryText';
import { TONE_CLASSES, statusTone } from '@/lib/statusTones';

/**
 * Try it on an answer check (SA.7, SA.7a): against the reference first, then a pasted reply.
 * The API extracts the last fenced json block and runs the check's scorer on the value at
 * its path; nothing is stored and no model is called. The result says what was compared,
 * the score and, where the threshold can be fractional, what it needs.
 */
const props = withDefaults(
  defineProps<{
    state: TryState | null;
    /** The path the check reads, for "Value at `overdue_count`". */
    path: string | null;
    readonly?: boolean;
  }>(),
  { readonly: false },
);
const emit = defineEmits<{ reply: [text: string] }>();
const open = defineModel<boolean>('open', { default: false });
const ids = useId();

const reference = computed(() => props.state?.reference ?? null);
const reply = computed(() => props.state?.replyResult ?? null);
const details = computed(() => (reply.value ? detailRows(reply.value) : { title: '', rows: [] }));
const extraction = computed(() => reply.value?.extraction ?? null);
const resultTone = computed(() =>
  reply.value ? statusTone('score', reply.value.status).tone : 'que',
);
</script>

<template>
  <div class="rounded-6 border border-border bg-surface" data-testid="try-it">
    <div
      class="flex items-center justify-between gap-10 px-12 py-8"
      :class="open ? 'border-b border-border' : ''"
    >
      <button
        type="button"
        class="inline-flex items-center gap-8 border-0 bg-transparent p-0 font-semibold"
        :aria-expanded="open"
        :aria-controls="`${ids}-body`"
        @click="open = !open"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          :class="open ? 'rotate-90' : ''"
        >
          <path
            d="M4 2.5 7.5 6 4 9.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        Try it
      </button>
      <span class="inline-flex items-center gap-8">
        <span class="text-12 text-text-3">Against the reference</span>
        <StatusChip
          v-if="reference"
          kind="score"
          :status="reference.status"
          data-testid="try-reference-chip"
        />
        <span v-else-if="state?.referenceError" class="text-12 text-fail-text" role="alert">{{
          state.referenceError
        }}</span>
        <span
          v-else
          class="h-16 w-60 animate-shimmer rounded-3 bg-surface-3"
          aria-label="Checking"
        />
      </span>
    </div>
    <div v-if="open" :id="`${ids}-body`" class="flex flex-col gap-12 p-12">
      <div v-if="reference" class="flex flex-wrap items-center gap-8 text-12">
        <b>Against the reference:</b>
        <span
          class="font-semibold"
          :class="TONE_CLASSES[statusTone('score', reference.status).tone].text"
          >{{ reference.status }}</span
        >
        <span class="text-text-2">· <CodeText :text="referenceLine(reference)" /></span>
      </div>
      <div class="flex flex-col gap-4">
        <label :for="`${ids}-reply`" class="text-12 font-medium text-text-2"
          >Sample final reply</label
        >
        <textarea
          :id="`${ids}-reply`"
          class="min-h-72 resize-y rounded-4 border border-border-strong bg-surface px-10 py-8 font-mono text-12 leading-18"
          :value="state?.reply ?? ''"
          :readonly="readonly"
          spellcheck="false"
          placeholder="Paste what an agent might reply, ending with its fenced json block."
          data-testid="try-reply"
          @input="emit('reply', ($event.target as HTMLTextAreaElement).value)"
        />
        <span class="text-12 text-text-3"
          >Paste what an agent might reply. Nothing is sent anywhere: the platform extracts and
          scores it here.</span
        >
      </div>
      <span v-if="state?.replyError" role="alert" class="text-12 text-fail-text">{{
        state.replyError
      }}</span>
      <template v-if="reply">
        <div class="grid grid-cols-2 items-start gap-12 max-md:grid-cols-1">
          <div class="flex min-w-0 flex-col gap-4">
            <span class="text-12 font-medium text-text-2">Extracted</span>
            <div
              v-if="extraction?.status === 'found' || extraction?.status === 'invalid'"
              class="relative"
            >
              <div
                class="rounded-4 border px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
                :class="
                  extraction.status === 'found'
                    ? 'border-accent bg-accent-soft'
                    : 'border-err bg-err-soft'
                "
                data-testid="try-extracted"
              >
                {{ extraction.block }}
              </div>
              <span
                v-if="extraction.status === 'found'"
                class="absolute -top-8 right-8 h-16 rounded-3 bg-accent px-6 text-11 leading-16 font-medium text-on-accent"
                >extracted</span
              >
              <span v-else class="text-12 text-err-text">{{ extraction.error }}</span>
            </div>
            <div
              v-else
              class="rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-12 leading-18 text-text-2"
            >
              No fenced json block found in the reply
            </div>
          </div>
          <div class="flex min-w-0 flex-col gap-4">
            <span class="text-12 font-medium text-text-2"
              ><template v-if="path"
                >Value at <code>{{ path }}</code></template
              ><template v-else>The whole answer</template></span
            >
            <div
              class="rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
              data-testid="try-value"
            >
              {{ reply.value === null ? '—' : compact(JSON.parse(reply.value)) }}
            </div>
          </div>
        </div>
        <div v-if="details.rows.length" class="flex flex-col gap-4">
          <span class="text-12 font-medium text-text-2">{{ details.title }}</span>
          <div class="overflow-hidden rounded-4 border border-border" data-testid="try-details">
            <div
              v-for="row in details.rows"
              :key="row.label"
              class="grid min-h-28 grid-cols-[20px_minmax(160px,auto)_minmax(0,1fr)] items-center gap-8 border-b border-border px-10 py-3 last:border-b-0"
              :class="row.ok ? '' : 'bg-fail-soft'"
              :data-ok="row.ok"
            >
              <span class="inline-flex" :class="row.ok ? 'text-pass' : 'text-fail'">
                <NoteIcon v-if="row.ok" kind="ok" />
                <svg
                  v-else
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  class="mt-2"
                >
                  <path
                    d="M18 6 6 18M6 6l12 12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.25"
                    stroke-linecap="round"
                  />
                </svg>
                <span class="sr-only">{{ row.ok ? 'matches' : 'does not match' }}</span>
              </span>
              <code class="text-12">{{ row.label }}</code>
              <span
                class="text-12"
                :class="row.ok ? 'text-text-3' : 'font-medium text-fail-text'"
                >{{ row.note }}</span
              >
            </div>
          </div>
        </div>
        <div
          class="flex flex-wrap items-center gap-10 rounded-4 px-10 py-8"
          :class="TONE_CLASSES[resultTone].soft"
          role="status"
          data-testid="try-result"
        >
          <StatusChip kind="score" :status="reply.status" />
          <span class="text-12"><CodeText :text="resultLine(reply)" /></span>
        </div>
      </template>
    </div>
  </div>
</template>

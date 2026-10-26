<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { SuiteDraftView } from '@/api/types/authoring';
import { plural } from '@/lib/format';
import CodeText from '../editors/CodeText.vue';
import {
  combineBlockedReason,
  combineLabel,
  conflictCause,
  conflictGuidance,
  conflictHeadline,
  type ConflictChoices,
} from '../conflict/conflict';
import { barMeta, changeChip } from './draftText';

/**
 * The bar under the suite's header while a draft exists (Components 5, SuiteDraftBar; SA.3,
 * SA.12): what the draft is based on, its changes as chips ("+2 more" past three), "saved
 * 16:31", Review and save as vN, and Discard draft, which asks first in the bar ("Discard
 * 3 changes? Nothing on disk changes."). Review and save is blocked only by a suite-level
 * problem, whose sentence shows under it. When the folder moved past the base it turns
 * amber, says what happened, and offers Review differences and Combine onto vN, which waits
 * for a choice per task both sides changed. While a save runs the button reads "Saving as
 * vN…" and leads to its progress (copy no board draws: SA.11 draws the steps on its page).
 */
const props = withDefaults(
  defineProps<{
    draft: SuiteDraftView;
    /** An autosave is on its way: the line reads "saving…". */
    saving?: boolean;
    /** The version kept of each overlapping task, from the conflict resolver (SA.12). */
    choices?: ConflictChoices;
    /** Review and save (/suites/:suite/save). */
    reviewTo: RouteLocationRaw;
    /** Discarding or combining: the bar's buttons wait. */
    busy?: boolean;
    /** A failed discard or combine, verbatim. */
    error?: string | null;
  }>(),
  { saving: false, choices: () => ({}), busy: false, error: null },
);
const emit = defineEmits<{ discard: []; combine: []; reviewDifferences: [] }>();

const confirming = ref(false);
const showAll = ref(false);
const keepButton = ref<HTMLButtonElement | null>(null);
const discardButton = ref<HTMLButtonElement | null>(null);

const chips = computed(() => props.draft.changes.map(changeChip));
const shown = computed(() =>
  showAll.value || chips.value.length <= 3 ? chips.value : chips.value.slice(0, 2),
);
const hidden = computed(() => chips.value.slice(shown.value.length));
const meta = computed(() => barMeta(props.draft, props.saving));
const conflict = computed(() => props.draft.conflict);
// The conflict's sentences are the resolver's own (components/authoring/conflict/conflict.ts).
const lines = computed(() => {
  const c = conflict.value;
  if (!c) return null;
  return {
    lead: conflictHeadline(props.draft.path),
    detail: conflictCause(c),
    overlap: conflictGuidance(c, props.choices),
    strong: c.overlap.length > 0,
  };
});
const blocked = computed(() => props.draft.problems[0]?.message ?? null);
const combineBlocked = computed(() =>
  conflict.value ? combineBlockedReason(conflict.value, props.choices) : null,
);

async function askDiscard(): Promise<void> {
  confirming.value = true;
  await nextTick();
  keepButton.value?.focus();
}

async function keep(): Promise<void> {
  confirming.value = false;
  await nextTick();
  discardButton.value?.focus();
}
</script>

<template>
  <div
    role="region"
    aria-label="Draft"
    class="sticky top-0 z-3 flex flex-col rounded-6 border"
    :class="conflict ? 'border-ung bg-ung-soft' : 'border-border border-b-border-strong bg-surface'"
    data-testid="suite-draft-bar"
    :data-state="conflict ? (conflict.overlap.length ? 'conflict-overlap' : 'conflict') : 'normal'"
  >
    <div v-if="lines" role="status" class="flex items-start gap-10 px-14 pt-10">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.25"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class="mt-2 flex-none text-ung-text"
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      <div class="flex flex-col gap-2">
        <span
          ><b class="text-ung-text"><CodeText :text="lines.lead" /></b>{{ ' '
          }}<span class="text-text-2"><CodeText :text="lines.detail" /></span
        ></span>
        <span :class="lines.strong ? 'font-medium' : 'text-text-2'" data-testid="conflict-overlap"
          ><CodeText :text="lines.overlap"
        /></span>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-x-16 gap-y-10 px-14 py-10">
      <div class="flex items-baseline gap-8 whitespace-nowrap">
        <b class="text-13">Draft</b
        ><span class="text-text-2" data-testid="draft-meta">{{ meta }}</span>
      </div>
      <div
        class="flex min-w-240 flex-1 flex-wrap items-center gap-6"
        aria-label="Changes in this draft"
      >
        <span
          v-for="(chip, i) in shown"
          :key="i"
          class="inline-flex h-22 items-center gap-4 rounded-3 border border-border bg-surface-2 px-7 text-12 whitespace-nowrap text-text-2"
          data-testid="change-chip"
          >{{ chip.kind }} <code class="text-11 text-text">{{ chip.target }}</code></span
        >
        <button
          v-if="hidden.length"
          type="button"
          class="inline-flex h-22 items-center rounded-3 border border-border bg-surface-2 px-7 text-12 whitespace-nowrap text-text-2"
          :title="hidden.map((c) => `${c.kind} ${c.target}`).join(' · ')"
          :aria-expanded="showAll"
          @click="showAll = true"
        >
          +{{ hidden.length }} more
        </button>
        <span v-if="chips.length === 0 && draft.tasks.length === 0" class="text-text-3"
          >No tasks yet</span
        >
      </div>
      <div class="flex flex-wrap items-center gap-8">
        <template v-if="conflict">
          <button type="button" class="btn" :disabled="busy" @click="emit('reviewDifferences')">
            Review differences
          </button>
          <button
            type="button"
            class="btn primary"
            :disabled="busy || !!combineBlocked"
            :title="combineBlocked ?? undefined"
            data-testid="combine"
            @click="emit('combine')"
          >
            {{ combineLabel(conflict) }}
          </button>
        </template>
        <template v-else>
          <RouterLink
            v-if="draft.saving"
            class="btn primary"
            :to="reviewTo"
            data-testid="review-save"
            >Saving as v{{ draft.nextVersion }}…</RouterLink
          >
          <span
            v-else-if="blocked"
            class="btn primary opacity-45"
            aria-disabled="true"
            :title="blocked"
            data-testid="review-save"
            >Review and save as v{{ draft.nextVersion }}</span
          >
          <RouterLink v-else class="btn primary" :to="reviewTo" data-testid="review-save"
            >Review and save as v{{ draft.nextVersion }}</RouterLink
          >
        </template>
        <button
          ref="discardButton"
          type="button"
          class="btn ghost"
          :aria-expanded="confirming"
          :disabled="busy"
          @click="askDiscard"
        >
          Discard draft
        </button>
      </div>
    </div>
    <div
      v-if="blocked && !conflict"
      class="px-14 pb-10 text-right text-12 text-text-2"
      data-testid="review-blocked"
    >
      {{ blocked }}
    </div>
    <div v-if="error" role="alert" class="mx-14 mb-10 text-12 text-fail-text">{{ error }}</div>
    <div
      v-if="confirming"
      role="alertdialog"
      aria-label="Discard draft"
      class="mx-14 mb-12 flex flex-wrap items-center gap-x-16 gap-y-10 rounded-6 border border-fail bg-fail-soft px-12 py-10"
      @keydown.esc="keep"
    >
      <span class="min-w-260 flex-1"
        ><b class="text-fail-text">{{
          draft.changes.length
            ? `Discard ${plural(draft.changes.length, 'change')}?`
            : 'Discard this draft?'
        }}</b
        >{{ ' ' }}<span class="text-text-2">Nothing on disk changes.</span></span
      >
      <button type="button" class="btn danger" :disabled="busy" @click="emit('discard')">
        Discard
      </button>
      <button ref="keepButton" type="button" class="btn" @click="keep">Keep editing</button>
    </div>
  </div>
</template>

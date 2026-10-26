<script lang="ts">
/** The states of the panel, one per moment of a save. */
export type SavePhase =
  'review' | 'confirm' | 'saving' | 'created' | 'nochanges' | 'notsaved' | 'offline';
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type {
  DraftReview,
  DraftSaveProgress,
  DraftSaveResult,
  SaveStep,
} from '@/api/types/authoring';
import CodeText from '@/components/suites/CodeText.vue';
import { changePhrases, keysText } from '@/components/suites/suiteFormat';
import CopyCommand from '@/components/ui/CopyCommand.vue';
import { plural } from '@/lib/format';
import ReadinessDot from './ReadinessDot.vue';
import SaveSteps from './SaveSteps.vue';

/**
 * The sticky right panel of Review and save (SA.11), in each state of a save: the changed
 * tasks' readiness and Save; the confirmation when a task would be stored invalid; the
 * steps while the worker saves; the version created (Open suite, New experiment on it); no
 * changes; not saved (the loader's line, nothing on disk changed, the draft kept); and no
 * worker. A conflict found while saving goes back to the draft instead.
 */
const props = withDefaults(
  defineProps<{
    phase: SavePhase;
    review: DraftReview;
    /** As shown: `./suites/invoices-v1/`. */
    folderPath: string;
    progress?: DraftSaveProgress | null;
    result?: DraftSaveResult | null;
    failure?: { step: SaveStep; message: string } | null;
    suiteTo?: RouteLocationRaw | null;
    experimentTo?: RouteLocationRaw | null;
    draftTo: RouteLocationRaw;
    /** Save is refused while a suite-level problem stands (an empty label). */
    blockedReason?: string | null;
  }>(),
  {
    progress: null,
    result: null,
    failure: null,
    suiteTo: null,
    experimentTo: null,
    blockedReason: null,
  },
);
defineEmits<{ save: []; confirm: []; keepEditing: []; retry: [] }>();

const next = computed(() => props.review.draft.nextVersion);
const base = computed(() => props.review.draft.base?.versionNumber ?? null);
const readyCount = computed(
  () => props.review.readiness.filter((r) => r.readiness !== 'problems').length,
);
const allReady = computed(() => readyCount.value === props.review.readiness.length);
const invalid = computed(() => props.review.invalid);

/** "1 added: overdue_count · 1 changed: total_due · 13 tasks, 12 valid". */
const savedLine = computed(() => {
  const r = props.result;
  if (!r) return [];
  const order = ['added', 'changed', 'removed', 'now invalid', 'now valid'];
  const phrases = [...changePhrases(r.changes, 'history')].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
  const parts = phrases.map((p) => ({
    lead: `${p.keys.length} ${p.kind}:`,
    keys: keysText(p),
  }));
  return [...parts, { lead: `${plural(r.taskCount, 'task')}, ${r.validCount} valid`, keys: '' }];
});
</script>

<template>
  <div
    class="flex flex-col gap-12 rounded-6 border border-border bg-surface p-16"
    data-testid="save-panel"
    :data-phase="phase"
  >
    <template v-if="phase === 'review' || phase === 'confirm'">
      <b class="text-15">Readiness across tasks</b>
      <div v-if="review.readiness.length" class="flex items-center gap-8">
        <ReadinessDot :readiness="allReady ? 'ready' : 'problems'" />
        <b :class="allReady ? 'text-pass-text' : 'text-err-text'"
          >{{ readyCount }} of {{ review.readiness.length }} changed tasks ready</b
        >
      </div>
      <div
        v-for="row in review.readiness"
        :key="row.key"
        class="grid grid-cols-[12px_minmax(0,1fr)] items-start gap-8 border-b border-border py-6"
        :data-task="row.key"
      >
        <span class="mt-6"><ReadinessDot :readiness="row.readiness" /></span>
        <span class="flex flex-col">
          <span class="font-mono font-semibold">{{ row.key }}</span>
          <span
            class="text-12 leading-16"
            :class="row.readiness === 'problems' ? 'text-err-text' : 'text-text-3'"
            data-testid="readiness-note"
            >{{ row.state }} · <CodeText :text="row.note"
          /></span>
        </span>
      </div>

      <template v-if="phase === 'confirm'">
        <p class="text-12 leading-18">
          {{ plural(invalid.length, 'task') }} will be saved as invalid and can't be launched:
          <template v-for="(item, i) in invalid" :key="item.key"
            ><code>{{ item.key }}</code> ({{ item.reason }}){{
              i < invalid.length - 1 ? ', ' : ''
            }}</template
          >.
        </p>
        <div
          role="group"
          aria-label="Confirm save"
          class="flex flex-col gap-8 rounded-6 border border-ung bg-ung-soft px-12 py-10"
          data-testid="confirm-invalid"
        >
          <b class="text-ung-text">Save with {{ plural(invalid.length, 'invalid task') }}?</b>
          <span class="text-12 leading-18 text-text-2"
            >It is stored as invalid, exactly as a broken file on disk would be. Fix it later and
            save again.</span
          >
          <div class="flex gap-8">
            <button type="button" class="btn primary" data-primary @click="$emit('confirm')">
              Save with {{ plural(invalid.length, 'invalid task') }}
            </button>
            <button type="button" class="btn" @click="$emit('keepEditing')">Keep editing</button>
          </div>
        </div>
      </template>
      <template v-else>
        <button
          type="button"
          class="btn primary h-36 w-full"
          :aria-disabled="blockedReason ? 'true' : undefined"
          :title="blockedReason ?? undefined"
          data-testid="save-draft"
          @click="$emit('save')"
        >
          Save as v{{ next }}
        </button>
        <p v-if="blockedReason" class="text-12 text-fail-text" role="alert">{{ blockedReason }}</p>
        <p class="text-12 text-text-3">
          Writes the files, loads them and runs the self-checks, exactly as a reload does. Creates
          v{{ next }}.<template v-if="base !== null">
            Experiments on v{{ base }} keep v{{ base }}.</template
          >
        </p>
      </template>
    </template>

    <template v-else-if="phase === 'saving'">
      <b class="text-15">Saving v{{ next }}…</b>
      <SaveSteps
        state="progress"
        :step="progress?.step ?? 'staging'"
        :self-checks="progress?.selfChecks ?? null"
        :folder-path="folderPath"
      />
      <p class="text-12 text-text-3">
        Nothing in <code>{{ folderPath }}</code> changes until the last step.
      </p>
    </template>

    <template v-else-if="phase === 'created' && result">
      <div
        role="status"
        class="flex flex-col gap-6 rounded-6 border border-pass bg-pass-soft px-12 py-10"
        data-testid="save-created"
      >
        <b class="text-pass-text"
          >v{{ result.suite.versionNumber }}
          {{ result.outcome === 'reverted' ? 'restored' : 'saved' }}</b
        >
        <span class="text-12 leading-18"
          ><template v-for="(part, i) in savedLine" :key="i"
            >{{ i > 0 ? ' · ' : '' }}{{ part.lead
            }}<template v-if="part.keys"
              >{{ ' ' }}<code>{{ part.keys }}</code></template
            ></template
          ></span
        >
      </div>
      <SaveSteps
        state="done"
        :folder-path="folderPath"
        :self-checks="progress?.selfChecks ?? null"
      />
      <div class="flex flex-wrap gap-8">
        <RouterLink v-if="suiteTo" class="btn" :to="suiteTo">Open suite</RouterLink>
        <RouterLink v-if="experimentTo" class="btn primary" :to="experimentTo"
          >New experiment on v{{ result.suite.versionNumber }}</RouterLink
        >
      </div>
      <p class="text-12 text-text-3">
        The draft is gone. Suite detail shows v{{ result.suite.versionNumber }}, and its History has
        a new row.
      </p>
    </template>

    <template v-else-if="phase === 'nochanges' && result">
      <div
        role="status"
        class="flex items-start gap-10 rounded-6 border border-border bg-surface-2 px-12 py-10"
        data-testid="save-unchanged"
      >
        <span class="flex flex-col gap-2">
          <b
            >Nothing changed. <code>{{ result.suite.name }}</code> stays at v{{
              result.suite.versionNumber
            }}.</b
          >
          <span class="text-12 text-text-2">The draft is cleared.</span>
        </span>
      </div>
      <RouterLink v-if="suiteTo" class="btn self-start" :to="suiteTo">Open suite</RouterLink>
    </template>

    <template v-else-if="phase === 'notsaved' && failure">
      <div
        role="alert"
        class="flex items-start gap-10 rounded-6 border border-fail bg-fail-soft px-12 py-10"
        data-testid="save-failed"
      >
        <span class="text-12 leading-18"
          ><b class="text-fail-text">Not saved.</b>{{ ' '
          }}<CodeText :text="failure.message.replace(/\.$/, '')" />. Nothing on disk changed. Your
          draft is kept.</span
        >
      </div>
      <SaveSteps
        state="failed"
        :step="failure.step"
        :folder-path="folderPath"
        :failure="failure.message"
      />
      <RouterLink class="btn primary self-start" :to="draftTo">Back to the draft</RouterLink>
    </template>

    <template v-else-if="phase === 'offline'">
      <div
        role="alert"
        class="flex items-start gap-10 rounded-6 border border-ung bg-ung-soft px-12 py-10"
        data-testid="save-offline"
      >
        <span class="text-12 leading-18"
          ><b class="text-ung-text">No worker is running.</b> Saving needs the worker. Your draft is
          kept.</span
        >
      </div>
      <CopyCommand command="docker compose up -d worker" />
      <button type="button" class="btn self-start" @click="$emit('retry')">Try again</button>
    </template>
  </div>
</template>

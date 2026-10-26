<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { errorMessage } from '@/api/client';
import type { DraftTaskDiff, SuiteDraftView } from '@/api/types/authoring';
import type { TaskDiff } from '@/api/types/suites';
import CodeText from '@/components/suites/CodeText.vue';
import ZoneLabel from '@/components/suites/ZoneLabel.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { plural } from '@/lib/format';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import { useSuitesStore } from '@/stores/suites';
import { hhmm } from '../draft-bar/draftText';
import type { ConflictChoice, ConflictChoices } from './conflict';
import { sideSummary, sideText } from './conflictSides';

/**
 * The overlap resolver of a draft conflict (DraftConflict board, SA.12): for each task both
 * the draft and the newer version on disk changed, the two versions side by side, each with
 * its prompt and task.yaml as they now read and what it changed against the base, to keep
 * one of: "Keep my version" or "Keep the version on disk". Keeping a side keeps that whole
 * task. The draft page puts it under the amber SuiteDraftBar, whose Combine sends the
 * choices (conflict.ts, rebaseRequest).
 */
const props = defineProps<{ draft: SuiteDraftView }>();
const choices = defineModel<ConflictChoices>('choices', { default: () => ({}) });

const authoring = useSuiteAuthoringStore();
const suites = useSuitesStore();

const conflict = computed(() => props.draft.conflict);
const baseVersion = computed(() => conflict.value?.baseVersion ?? 0);

interface Sides {
  mine: DraftTaskDiff | null;
  disk: TaskDiff | null;
  error: string | null;
}
const sides = ref<Record<string, Sides>>({});

async function loadSides(key: string): Promise<void> {
  const c = conflict.value;
  const baseId = props.draft.base?.suiteId;
  if (!c || !baseId) return;
  try {
    const [mine, disk] = await Promise.all([
      authoring.loadTaskDiff(props.draft.folder, key),
      suites.loadDiff(c.current.suiteId, key, baseId),
    ]);
    sides.value = { ...sides.value, [key]: { mine, disk, error: null } };
  } catch (err) {
    sides.value = { ...sides.value, [key]: { mine: null, disk: null, error: errorMessage(err) } };
  }
}
watch(
  () => conflict.value?.overlap ?? [],
  (keys) => {
    for (const key of keys) if (!sides.value[key]) void loadSides(key);
  },
  { immediate: true },
);

function choose(key: string, side: ConflictChoice): void {
  choices.value = { ...choices.value, [key]: side };
}

/** "Nothing else overlaps: `overdue_count` and the label combine as they are, and `late_fees` comes from v7." */
const restLine = computed(() => {
  const c = conflict.value;
  if (!c) return '';
  const overlap = new Set(c.overlap);
  const mine = c.draftKeys.filter((k) => !overlap.has(k)).map((k) => `\`${k}\``);
  if (props.draft.changes.some((ch) => ch.kind === 'label')) mine.push('the label');
  const d = c.diskChanges;
  const theirs = [...new Set([...d.changed, ...d.added, ...d.removed])]
    .filter((k) => !overlap.has(k))
    .map((k) => `\`${k}\``);
  const list = (xs: string[]) =>
    xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  const parts: string[] = [];
  if (mine.length) parts.push(`${list(mine)} combine as they are`);
  if (theirs.length)
    parts.push(
      `${list(theirs)} ${theirs.length === 1 ? 'comes' : 'come'} from v${c.current.versionNumber}`,
    );
  return parts.length ? `Nothing else overlaps: ${parts.join(', and ')}.` : '';
});
</script>

<template>
  <div
    v-if="conflict && conflict.overlap.length"
    class="flex flex-col gap-16"
    data-testid="conflict-resolver"
  >
    <section
      v-for="key in conflict.overlap"
      :key="key"
      class="overflow-hidden rounded-6 border border-ung bg-surface"
      :aria-labelledby="`overlap-${key}`"
      :data-overlap="key"
    >
      <div
        class="flex items-center justify-between gap-10 border-b border-border bg-ung-soft px-16 py-12"
      >
        <h2 :id="`overlap-${key}`" class="text-15 font-semibold">
          <code class="text-14">{{ key }}</code> changed in your draft and on disk
        </h2>
        <span class="text-12 text-ung-text"
          >{{ plural(conflict.overlap.length, 'overlap') }} · choose one version</span
        >
      </div>
      <ErrorBanner
        v-if="sides[key]?.error"
        class="m-16"
        :title="`Could not load both versions of ${key}`"
        :detail="sides[key]!.error"
        retry-label="Retry"
        compact
        @retry="loadSides(key)"
      />
      <div
        v-else
        role="radiogroup"
        :aria-label="`Which version of ${key} to keep`"
        class="grid grid-cols-2 gap-16 p-16 max-lg:grid-cols-1"
      >
        <label
          v-for="side in ['mine', 'disk'] as const"
          :key="side"
          class="flex cursor-pointer flex-col gap-10 rounded-6 border px-12 py-10"
          :class="
            choices[key] === side
              ? 'border-accent bg-accent-soft'
              : 'border-border-strong bg-surface'
          "
          :data-side="side"
        >
          <span class="flex items-center gap-8">
            <input
              type="radio"
              :name="`overlap-${key}`"
              :checked="choices[key] === side"
              @change="choose(key, side)"
            />
            <b>{{ side === 'mine' ? 'Keep my version' : 'Keep the version on disk' }}</b>
            <span class="text-12 text-text-3">{{
              side === 'mine'
                ? `Your draft · based on v${baseVersion}`
                : `On disk · v${conflict.current.versionNumber}, loaded ${hhmm(conflict.current.loadedAt)}`
            }}</span>
          </span>
          <template v-if="side === 'mine' ? sides[key]?.mine : sides[key]?.disk">
            <span class="flex items-center gap-8"
              ><span class="text-12 font-medium text-text-2">prompt.md</span
              ><ZoneLabel zone="visible"
            /></span>
            <pre
              class="rounded-4 border border-border bg-surface-2 px-10 py-8 font-mono text-12 leading-18 whitespace-pre-wrap"
            ><template v-for="(line, i) in sideText((side === 'mine' ? sides[key]!.mine! : sides[key]!.disk!).prompt)" :key="i"><span :class="{ 'bg-pass-soft': line.changed }">{{ line.text || ' ' }}</span>
</template></pre>
            <span class="flex items-center gap-8"
              ><span class="text-12 font-medium text-text-2">task.yaml</span
              ><ZoneLabel zone="hidden"
            /></span>
            <pre
              class="rounded-4 border border-border bg-surface-2 px-10 py-8 font-mono text-12 leading-18 whitespace-pre-wrap"
            ><template v-for="(line, i) in sideText((side === 'mine' ? sides[key]!.mine! : sides[key]!.disk!).taskYaml)" :key="i"><span :class="{ 'bg-pass-soft': line.changed }">{{ line.text || ' ' }}</span>
</template></pre>
            <span class="text-12 text-text-3" data-testid="side-summary">{{
              sideSummary(side === 'mine' ? sides[key]!.mine! : sides[key]!.disk!, baseVersion)
            }}</span>
          </template>
          <span v-else class="h-120 animate-shimmer rounded-4 bg-surface-2" aria-busy="true" />
        </label>
      </div>
      <p class="px-16 pb-14 text-12 text-text-3">
        Keeping one version keeps that whole task. The other side's change to
        <code>{{ key }}</code> is dropped, and you can redo it in the editor after combining.
        <CodeText v-if="restLine" :text="restLine" />
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { errorMessage } from '@/api/client';
import type { DraftChange, DraftTaskDiff } from '@/api/types/authoring';
import BaseTag from '@/components/ui/BaseTag.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { useSuiteAuthoringStore } from '@/stores/suites-authoring';
import DraftTaskDiffView from './DraftTaskDiffView.vue';

/**
 * The Changes panel of Review and save (SA.11): one row per change of the draft against its
 * base, with its one-line summary. A task's row opens its TaskDiff against the base version
 * (fetched when it opens; the first rows start open); suite.yaml's label, description and
 * order are one line each.
 */
const props = defineProps<{
  folder: string;
  changes: { change: DraftChange; detail: string }[];
  /** "against v6", or "a new suite" for a draft with no base. */
  baseVersion: number | null;
}>();

const store = useSuiteAuthoringStore();
/** Rows open at first: every task row when there are a few. */
const OPEN_AT_FIRST = 3;

interface Row {
  id: string;
  tag: string;
  target: string;
  detail: string;
  /** The task whose diff the row opens; null for suite.yaml and removed tasks. */
  key: string | null;
}

const rows = computed<Row[]>(() =>
  props.changes.map(({ change, detail }, i) => {
    switch (change.kind) {
      case 'added':
      case 'changed':
        return { id: `${i}`, tag: change.kind, target: change.key, detail, key: change.key };
      case 'restored':
        return {
          id: `${i}`,
          tag: `restored from v${change.fromSuiteVersion}`,
          target: change.key,
          detail,
          key: change.key,
        };
      case 'removed':
        return { id: `${i}`, tag: 'removed', target: change.key, detail, key: null };
      default:
        return { id: `${i}`, tag: change.kind, target: 'suite.yaml', detail, key: null };
    }
  }),
);

const open = ref<Set<string>>(new Set());
const diffs = ref<Record<string, DraftTaskDiff>>({});
const errors = ref<Record<string, string>>({});

async function loadDiff(key: string): Promise<void> {
  if (diffs.value[key]) return;
  try {
    // Read the answer first: two rows load at once, and each keeps the other's.
    const diff = await store.loadTaskDiff(props.folder, key);
    diffs.value = { ...diffs.value, [key]: diff };
    const rest = { ...errors.value };
    delete rest[key];
    errors.value = rest;
  } catch (err) {
    errors.value = { ...errors.value, [key]: errorMessage(err) };
  }
}

function toggle(row: Row): void {
  if (!row.key) return;
  const next = new Set(open.value);
  if (next.has(row.id)) next.delete(row.id);
  else {
    next.add(row.id);
    void loadDiff(row.key);
  }
  open.value = next;
}

watch(
  rows,
  (list) => {
    const tasks = list.filter((r) => r.key !== null);
    if (tasks.length > OPEN_AT_FIRST) return;
    open.value = new Set(tasks.map((r) => r.id));
    for (const r of tasks) void loadDiff(r.key!);
  },
  { immediate: true },
);

const TAG: Record<string, string> = {
  added: 'border-transparent bg-pass-soft text-pass-text',
  changed: 'border-transparent bg-run-soft text-run-text',
  removed: 'border-transparent bg-que-soft text-que-text',
};
const tagClass = (tag: string): string =>
  tag.startsWith('restored') ? TAG.changed! : (TAG[tag] ?? '');
</script>

<template>
  <section
    class="rounded-6 border border-border bg-surface"
    aria-labelledby="save-changes"
    data-testid="draft-changes"
  >
    <div class="flex items-center justify-between gap-10 border-b border-border px-16 py-12">
      <h2 id="save-changes" class="text-15 font-semibold">Changes</h2>
      <span class="text-12 text-text-3">{{
        baseVersion === null
          ? 'a new suite: every task is added'
          : `against v${baseVersion} · each row opens its TaskDiff`
      }}</span>
    </div>
    <p v-if="rows.length === 0" class="px-16 py-12 text-text-3">
      The draft has no changes against v{{ baseVersion }}.
    </p>
    <div
      v-for="row in rows"
      :key="row.id"
      class="border-b border-border last:border-b-0"
      :data-change="row.tag"
      :data-target="row.target"
    >
      <component
        :is="row.key ? 'button' : 'div'"
        :type="row.key ? 'button' : undefined"
        class="flex w-full flex-wrap items-center gap-10 px-16 py-10 text-left"
        :aria-expanded="row.key ? (open.has(row.id) ? 'true' : 'false') : undefined"
        @click="toggle(row)"
      >
        <span class="w-10 text-text-3" aria-hidden="true">{{
          row.key ? (open.has(row.id) ? '▾' : '▸') : '·'
        }}</span>
        <BaseTag :class="tagClass(row.tag)">{{ row.tag }}</BaseTag>
        <span class="font-mono font-semibold">{{ row.target }}</span>
        <span class="text-text-2">{{ row.detail }}</span>
      </component>
      <div v-if="row.key && open.has(row.id)" class="pr-16 pb-14 pl-40">
        <ErrorBanner
          v-if="errors[row.key]"
          :title="`Could not load the diff of ${row.key}`"
          :detail="errors[row.key]"
          retry-label="Retry"
          compact
          @retry="loadDiff(row.key)"
        />
        <DraftTaskDiffView v-else-if="diffs[row.key]" :diff="diffs[row.key]!" :folder="folder" />
        <div
          v-else
          class="h-120 animate-shimmer rounded-6 border border-border bg-surface-2"
          aria-busy="true"
        />
      </div>
    </div>
  </section>
</template>

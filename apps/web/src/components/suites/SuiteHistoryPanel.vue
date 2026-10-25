<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { SuiteHistoryEntry } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import { formatDateTime, MISSING, shortHash } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { CHANGE_CLASSES, changePhrases, keysText, versionLabel } from './suiteFormat';

/**
 * A suite directory's History (SuiteDetail board, plan 4.5): one row per load that created,
 * re-checked or reverted a version, newest first, with its time, the author's label, what
 * changed, the experiments that ran on it and its hash. A version opens that version.
 */
const props = defineProps<{
  history: SuiteHistoryEntry[];
  /** The version on screen, tinted. */
  viewedId: string;
}>();

/** The first row of the version on screen (a reverted version also has its created row). */
const viewedIndex = computed(() => props.history.findIndex((h) => h.suiteId === props.viewedId));

function note(entry: SuiteHistoryEntry): string {
  if (entry.sameFilesAs !== null) return `same files as v${entry.sameFilesAs}, re-checked`;
  if (entry.outcome === 'created' && entry.versionNumber === 1) return 'initial load';
  return '';
}

const suiteTo = (suiteId: string) => ({ name: ROUTE_NAMES.suite, params: { id: suiteId } });
const experimentTo = (id: string) => ({ name: ROUTE_NAMES.experimentOverview, params: { id } });
</script>

<template>
  <BasePanel clip aria-labelledby="suite-history">
    <template #header>
      <div class="flex items-center justify-between gap-10 border-b border-border px-16 py-12">
        <h2 id="suite-history" class="text-15 font-semibold">History</h2>
        <span class="text-12 text-text-3"
          >one row per reload that changed something or re-ran checks · click a version to view
          it</span
        >
      </div>
    </template>
    <div class="overflow-x-auto">
      <table class="dt static" aria-label="Suite versions">
        <thead>
          <tr>
            <th scope="col" class="w-150">Version</th>
            <th scope="col" class="w-120">Loaded</th>
            <th scope="col" class="w-70">Label</th>
            <th scope="col">Changes</th>
            <th scope="col">Used by experiments</th>
            <th scope="col" class="w-90">Hash</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(entry, i) in history"
            :key="i"
            :class="{ '[&>td]:bg-accent-soft': i === viewedIndex }"
            :data-version="entry.versionNumber"
            :data-viewed="i === viewedIndex ? 'true' : undefined"
          >
            <td>
              <RouterLink
                :to="suiteTo(entry.suiteId)"
                class="inline-flex items-center gap-6 hover:no-underline"
                :aria-current="i === viewedIndex ? 'page' : undefined"
              >
                <span class="font-mono font-semibold text-accent">{{
                  versionLabel(entry.versionNumber, entry.outcome === 'reverted')
                }}</span>
                <span
                  v-if="entry.current"
                  class="chip h-18 bg-surface-3 text-text"
                  data-testid="current-chip"
                  >current</span
                >
              </RouterLink>
            </td>
            <td class="text-text-2">{{ formatDateTime(entry.loadedAt) }}</td>
            <td class="text-text-3">{{ entry.versionLabel ?? MISSING }}</td>
            <td class="py-6 whitespace-normal">
              <div class="flex flex-wrap items-center gap-6">
                <span
                  v-for="phrase in changePhrases(entry.changes, 'history')"
                  :key="phrase.kind"
                  class="inline-flex h-20 items-center gap-4 rounded-3 px-6 text-11 font-medium whitespace-nowrap"
                  :class="CHANGE_CLASSES[phrase.kind]"
                  :data-change="phrase.kind"
                  >{{ phrase.kind }} <code class="text-11">{{ keysText(phrase) }}</code></span
                >
                <span v-if="note(entry)" class="text-12 text-text-3">{{ note(entry) }}</span>
              </div>
            </td>
            <td class="whitespace-normal">
              <template v-if="entry.experiments.length">
                <RouterLink
                  v-for="e in entry.experiments"
                  :key="e.id"
                  :to="experimentTo(e.id)"
                  class="block"
                  >{{ e.name }}</RouterLink
                >
              </template>
              <span v-else class="text-text-3">{{ MISSING }}</span>
            </td>
            <td>
              <BaseTag :title="entry.contentHash">{{ shortHash(entry.contentHash) }}</BaseTag>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </BasePanel>
</template>

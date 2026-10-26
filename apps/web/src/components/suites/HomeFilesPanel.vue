<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TaskHomeFile, TaskHomeFileKind } from '@/api/types/suites';
import BasePanel from '@/components/ui/BasePanel.vue';
import BaseTag from '@/components/ui/BaseTag.vue';
import { formatBytes, formatSha256 } from '@/lib/format';
import ZoneLabel from './ZoneLabel.vue';

/**
 * A task's home files of one kind (Phase 6 P1 and P2; no board draws them, so the panel is
 * FixturesPanel's table with a text preview instead of a table one):
 *   home_seed      Home seeds: home/memories/MEMORY.md and USER.md, copied into the agent's
 *                  home before every run in every configuration (visible to the agent)
 *   expected_home  Expected home: what a home check expects the home's files to be after a
 *                  run, laid over the seeds; never copied into a run (hidden from the agent)
 * Each row names the file as the task folder holds it, its kind, where it lands (or what it
 * stands for) in the home, its size and hash. A file with text opens it, as written; the
 * first one starts open.
 */
const props = defineProps<{ kind: TaskHomeFileKind; files: TaskHomeFile[] }>();

const shown = computed(() => props.files.filter((f) => f.kind === props.kind));
const seeds = computed(() => props.kind === 'home_seed');
const headingId = computed(() => `task-home-${props.kind}`);
const open = ref<string | null>(null);

watch(
  shown,
  (files) => {
    open.value = files.find((f) => f.text !== null)?.path ?? null;
  },
  { immediate: true },
);

const toggle = (f: TaskHomeFile): void => {
  open.value = open.value === f.path ? null : f.path;
};
const openFile = computed(() => shown.value.find((f) => f.path === open.value) ?? null);
</script>

<template>
  <BasePanel v-if="shown.length" :aria-labelledby="headingId" clip :data-home-kind="kind">
    <template #header>
      <div class="flex items-center justify-between gap-10 border-b border-border px-16 py-12">
        <span class="flex flex-wrap items-center gap-10">
          <h2 :id="headingId" class="text-15 font-semibold">
            {{ seeds ? 'Home seeds' : 'Expected home' }}
          </h2>
          <ZoneLabel :zone="seeds ? 'visible' : 'hidden'" />
          <span class="text-12 text-text-3">{{
            seeds
              ? "Copied into the agent's memories/ before every run, in every configuration; read only with memory on"
              : "What a home check expects the agent's memory files to hold, laid over the seeds; never copied into a run"
          }}</span>
        </span>
      </div>
    </template>
    <div class="overflow-x-auto">
      <table class="dt th30 inset14 static" :aria-label="seeds ? 'Home seeds' : 'Expected home'">
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">Kind</th>
            <th scope="col">In the home</th>
            <th scope="col" class="text-right">Size</th>
            <th scope="col">Hash</th>
            <th scope="col"><span class="sr-only">Text</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in shown" :key="f.path" :data-home-file="f.path">
            <td class="font-mono text-12 whitespace-normal">{{ f.path }}</td>
            <td>
              <BaseTag>{{ f.kind }}</BaseTag>
            </td>
            <td class="font-mono text-12 whitespace-normal text-text-2">
              {{ seeds ? `/opt/data/${f.homePath}` : f.homePath }}
            </td>
            <td class="text-right">{{ formatBytes(f.sizeBytes) }}</td>
            <td class="font-mono text-12 text-text-2" :title="f.sha256">
              {{ formatSha256(f.sha256) }}
            </td>
            <td class="text-right">
              <button
                v-if="f.text !== null"
                type="button"
                class="btn"
                :aria-expanded="open === f.path ? 'true' : 'false'"
                @click="toggle(f)"
              >
                {{ open === f.path ? 'Hide text' : 'Show text' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-if="openFile && openFile.text !== null"
      class="flex flex-col gap-6 border-t border-border px-16 pt-12 pb-16"
      data-testid="home-file-text"
    >
      <span class="text-12 text-text-3"
        ><code>{{ openFile.path }}</code> as written. Hermes separates entries with a line holding
        only §.</span
      >
      <pre
        class="rounded-4 border border-border bg-surface-2 px-12 py-10 font-mono text-12 leading-18 whitespace-pre-wrap"
        >{{ openFile.text }}</pre>
    </div>
  </BasePanel>
</template>

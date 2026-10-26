<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { artifactDownloadUrl } from '@/api/runs';
import type { ArtifactView, RunDetail } from '@/api/types/runs';
import { formatBytes, formatSha256 } from '@/lib/format';
import ArtifactPreview from './ArtifactPreview.vue';
import SectionHeading from './SectionHeading.vue';
import { memoryEnabledIn, ORIGIN_LABELS, previewKind } from './inspectorFormat';

/**
 * Section 4, Artifacts (RunInspector; RunInspectorStates › Cancelled): the files left in the
 * workspace after the run, labelled by origin (a fixture unchanged or modified, a document,
 * written by the agent), with size and hash, an inline preview for CSV and text files, and a
 * download. Files the agent wrote open their preview by default. A note says when the agent
 * wrote nothing, or that nothing was collected because the run never got a workspace (a setup
 * failure before launch); the heading carries the API's note ("partial · written before the
 * cancel").
 *
 * Files collected from the agent's home (root `home`: memories/MEMORY.md and USER.md, Phase 6
 * P2) follow in a Memory group of their own, labelled against the task's home seeds (a seed
 * unchanged or modified, or written by the agent). No board draws the group: it repeats the
 * workspace table under a sub-heading set like the launch record's. A finished run with
 * memory on (its config.yaml) and nothing collected from the home keeps the group, saying
 * "Memory is on; the agent saved nothing" (Phase 6 #11), so an empty memory is a finding
 * rather than a missing section.
 */
const props = defineProps<{ detail: RunDetail; sectionId: string }>();

const artifacts = computed(() => props.detail.artifacts);
const items = computed(() => artifacts.value.items);
const workspace = computed(() => items.value.filter((a) => a.root === 'workspace'));
const home = computed(() => items.value.filter((a) => a.root === 'home'));
const unfinished = computed(() => ['queued', 'running'].includes(props.detail.status));
/** Memory was on and the run is over, yet nothing came back from the home. */
const savedNothing = computed(
  () =>
    !unfinished.value &&
    home.value.length === 0 &&
    memoryEnabledIn(props.detail.launchRecord) === true,
);
const groups = computed(() => [
  { root: 'workspace' as const, items: workspace.value },
  ...(home.value.length || savedNothing.value
    ? [{ root: 'home' as const, items: home.value }]
    : []),
]);
const open = ref(new Set<string>());

/** What the agent wrote or changed: in the workspace its own files, in the home any change. */
const changedByAgent = (a: ArtifactView): boolean =>
  a.origin === 'agent' || a.origin === 'home_seed_modified';

watch(
  () => `${props.detail.id}:${props.detail.shownAttempt}:${items.value.length}`,
  () => {
    const first = (list: ArtifactView[]) =>
      list.filter((a) => changedByAgent(a) && previewKind(a) !== null).slice(0, 2);
    open.value = new Set([...first(workspace.value), ...first(home.value)].map((a) => a.id));
  },
  { immediate: true },
);

function toggle(id: string): void {
  const next = new Set(open.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  open.value = next;
}

const SKIPPED: Record<NonNullable<ArtifactView['skippedReason']>, string> = {
  too_large: 'not stored: the file is too large',
  over_budget: "not stored: the attempt's collection budget was used up",
};

/** Nothing was launched (a setup failure before the container): there was no workspace. */
const neverLaunched = computed(() => !unfinished.value && props.detail.launchRecord === null);
const note = computed(() => {
  if (unfinished.value) return 'Artifacts are collected when the run ends.';
  if (!items.value.length && neverLaunched.value) {
    return 'Nothing was collected: the run stopped before its workspace was set up.';
  }
  if (!workspace.value.length) {
    return 'The agent wrote no files in its workspace during this run, and this task has no fixture files.';
  }
  return artifacts.value.agentWroteNothing
    ? 'The agent wrote no files in its workspace during this run.'
    : null;
});
const previews = computed(() => items.value.filter((a) => open.value.has(a.id)));
</script>

<template>
  <section
    :id="sectionId"
    aria-labelledby="ri-h-artifacts"
    class="flex flex-col gap-10"
    data-testid="section-artifacts"
  >
    <SectionHeading id="ri-h-artifacts" :n="4" title="Artifacts">
      <span
        v-if="artifacts.note && !unfinished && !(neverLaunched && !items.length)"
        class="text-12 font-normal text-text-3"
        >{{ artifacts.note }}</span
      >
    </SectionHeading>
    <div
      v-for="group in groups"
      :key="group.root"
      class="flex flex-col gap-6"
      :data-testid="group.root === 'home' ? 'memory-group' : undefined"
    >
      <h3 v-if="group.root === 'home'" class="text-12 font-semibold text-text-2">
        Memory
        <span class="font-normal text-text-3"
          >· the agent's memory files, collected from <code>memories/</code> in its home after the
          run</span
        >
      </h3>
      <div class="overflow-x-auto rounded-6 border border-border bg-surface">
        <table
          v-if="group.items.length"
          class="dt wrap static"
          :aria-label="group.root === 'home' ? 'Memory files' : 'Artifacts'"
        >
          <thead>
            <tr>
              <th>Path</th>
              <th>Origin</th>
              <th class="text-right">Size</th>
              <th>Hash</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="artifact in group.items"
              :key="artifact.id"
              :data-origin="artifact.origin"
              :data-root="artifact.root"
              data-testid="artifact-row"
            >
              <td class="font-mono text-12 leading-20">{{ artifact.path }}</td>
              <td class="text-text-2">{{ ORIGIN_LABELS[artifact.origin] }}</td>
              <td class="text-right whitespace-nowrap">{{ formatBytes(artifact.sizeBytes) }}</td>
              <td class="font-mono text-12 leading-20 text-text-2">
                <template v-if="artifact.sha256">{{ formatSha256(artifact.sha256) }}</template>
                <span v-else-if="artifact.skippedReason" class="font-sans text-text-3">{{
                  SKIPPED[artifact.skippedReason]
                }}</span>
              </td>
              <td class="text-right whitespace-nowrap">
                <button
                  v-if="previewKind(artifact)"
                  type="button"
                  class="btn sm ghost"
                  :aria-pressed="open.has(artifact.id)"
                  :aria-label="`${open.has(artifact.id) ? 'Hide preview of' : 'Preview'} ${artifact.path}`"
                  @click="toggle(artifact.id)"
                >
                  {{ open.has(artifact.id) ? 'Hide preview' : 'Preview' }}
                </button>
                <a
                  v-if="artifact.sha256"
                  class="btn sm ghost"
                  :href="artifactDownloadUrl(detail.id, artifact.id)"
                  download
                  :aria-label="`Download ${artifact.path}`"
                  >Download</a
                >
              </td>
            </tr>
          </tbody>
        </table>
        <div
          v-if="group.root === 'home' && !group.items.length"
          class="px-16 py-12 text-text-2"
          data-testid="memory-note"
        >
          Memory is on; the agent saved nothing.
        </div>
        <div
          v-if="group.root === 'workspace' && note"
          class="px-16 text-text-2"
          :class="group.items.length ? 'border-t border-border py-10' : 'py-12'"
          data-testid="artifacts-note"
        >
          {{ note }}
        </div>
      </div>
    </div>
    <div v-if="previews.length" class="flex flex-wrap items-start gap-12">
      <ArtifactPreview
        v-for="artifact in previews"
        :key="artifact.id"
        :run-id="detail.id"
        :artifact="artifact"
      />
    </div>
  </section>
</template>

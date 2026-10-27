<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import type { LaunchRecordView } from '@/api/types/runs';
import {
  formatClock,
  formatCount,
  shortRevision,
  formatBytes,
  formatSha256,
  plural,
} from '@/lib/format';
import RichSentence from './RichSentence.vue';
import { shortDigest } from './inspectorFormat';

/**
 * Section 5, Launch record (RunInspector, RunInspectorMcp): what this attempt ran in,
 * collapsed by default, and opened by the header's jump link. The container (image and digest, the Hermes revision, network, user,
 * limits, mounts, disk cap, worker), the skills with their content hashes, the MCP servers and
 * where their secret values live, the exact command and the config.yaml written for the run.
 * Secrets never appear: the run token reads ‹run token, revoked› and an MCP value
 * `<from env NAME>`.
 *
 * Phase 6 adds three rows no board draws, set like their neighbours: how the skills were loaded
 * (preloaded with `-s`, or on demand through the `skills` toolset), the task's home seeds copied
 * into memories/ with their hashes, and config.yaml's background review intervals. Since Phase 8
 * (G9) the seeds are copied, and home/memories collected, only with memory on: with memory off
 * the row lists the seeds left out instead.
 */
const props = defineProps<{
  record: LaunchRecordView | null;
  sectionId: string;
  /** The run's status, for what to say when nothing was launched. */
  status?: string;
}>();

const expanded = ref(false);
const bodyId = `ri-launch-${useId()}`;
/** The header's "Launch record" link opens the section it jumps to. */
defineExpose({ open: () => (expanded.value = true) });
const c = computed(() => props.record?.container ?? null);

const limits = computed(() => {
  const l = c.value?.limits;
  if (!l) return '';
  return `${l.memory} memory · ${l.cpus} ${l.cpus === 1 ? 'CPU' : 'CPUs'} · ${formatCount(l.processes)} processes · ${l.tmp} /tmp`;
});
const diskCap = computed(() => {
  const d = c.value?.diskCap;
  return d ? `${formatBytes(d.bytes)} · ${formatCount(d.files)} files` : '';
});
const worker = computed(() => {
  const w = c.value?.worker;
  if (!w) return '';
  return [
    w.name,
    `started ${formatClock(w.startedAt)}`,
    w.exitCode !== null ? `exit ${w.exitCode}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
});
const skills = computed(() => {
  const list = c.value?.skills ?? [];
  if (!list.length)
    return "No added skills (Hermes' built-in `hermes-agent` skill is always loaded)";
  const named = list
    .map((s) => `\`${s.name}\` ${s.version} · content hash \`${formatSha256(s.contentHash)}\``)
    .join('; ');
  return `${named} · added on top of Hermes' built-in \`hermes-agent\` skill`;
});
const skillLoading = computed(() => {
  const container = c.value;
  if (!container?.skills.length) return null;
  return container.skillLoading === 'on_demand'
    ? 'on demand · installed in the home without `-s`; the agent lists and opens them through the `skills` toolset'
    : 'preload · each skill loaded into the prompt at start with `-s`';
});
/** Where the home is mounted in the trial: home seeds land under its memories/. */
const homeTarget = computed(
  () => c.value?.mounts.find((m) => m.name === 'home')?.target ?? '/opt/data',
);
const homeSeeds = computed(() =>
  (props.record?.homeSeeds ?? []).map((seed) => ({
    path: seed.path,
    target: `${homeTarget.value}/${seed.path}`,
    hash: formatSha256(seed.sha256),
  })),
);
/** Seeds memory off left out (Phase 8 G9): the record names them, home-relative. */
const skippedSeeds = computed(() => props.record?.homeMemory?.seedsSkipped ?? []);
/**
 * What the run did with memory in the home. A record from before Phase 8 has no homeMemory:
 * its seeds were copied in with memory off too.
 */
const homeNote = computed<string | null>(() => {
  const home = props.record?.homeMemory;
  if (!home) {
    return homeSeeds.value.length
      ? 'Copied from the task before launch, in every configuration. Hermes reads them only with memory on.'
      : null;
  }
  if (home.memoryEnabled) {
    return homeSeeds.value.length
      ? 'Memory is on: copied from the task before launch, and `home/memories` collected after the run.'
      : 'Memory is on: `home/memories` was collected after the run.';
  }
  return skippedSeeds.value.length
    ? 'Memory is off: these seeds were left out of the home, and `home/memories` was not collected, so nothing there counts as memory.'
    : 'Memory is off: `home/memories` was not collected.';
});
/** "10 (every 10 user turns)", "1 (every user turn)" or "0 (off)". */
const interval = (n: number, unit: string): string =>
  n === 0 ? '0 (off)' : `${formatCount(n)} (every ${n === 1 ? unit : plural(n, unit)})`;
const backgroundReview = computed(() => {
  const r = props.record?.backgroundReview;
  if (r === undefined) return null;
  if (r === null) {
    return [
      "Not written: Hermes's defaults applied (a record from before background review was pinned)",
    ];
  }
  // Hermes skips the review fork for a finite turn, which `chat --oneshot` is (Phase 6 P3).
  return [
    `\`memory.nudge_interval\` ${interval(r.memoryNudgeInterval, 'user turn')}`,
    `\`skills.creation_nudge_interval\` ${interval(r.skillCreationNudgeInterval, 'tool iteration')}`,
    'Written the same in every run; a one-shot run is a finite turn, for which Hermes starts no review',
  ];
});
const mcp = computed(() =>
  (c.value?.mcpServers ?? []).map((s) =>
    s.transport === 'stdio'
      ? `\`${s.name}\` v${s.version} · stdio · started fresh inside this run's container, stopped when the run ended. Its environment values are set in the server's environment inside this container: readable by the agent.`
      : `\`${s.name}\` v${s.version} · http · reached through egress. Header values are added by egress on each request: not present in this run.`,
  ),
);
</script>

<template>
  <section
    :id="sectionId"
    aria-labelledby="ri-h-launch"
    class="flex flex-col gap-10"
    data-testid="section-launch"
  >
    <h2 id="ri-h-launch" class="text-15 font-semibold">
      <button
        type="button"
        class="flex cursor-pointer items-center gap-10 border-0 bg-transparent p-0 text-left disabled:cursor-default"
        :aria-expanded="expanded"
        :aria-controls="bodyId"
        :disabled="!record"
        @click="expanded = !expanded"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          :class="{ 'rotate-90': expanded }"
        >
          <path
            d="M4 2.5L7.5 6 4 9.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <span class="font-mono text-12 font-medium text-text-3">5</span>Launch record
        <span class="text-12 font-normal text-text-3">{{
          record
            ? 'Container, command, config file'
            : status === 'queued'
              ? 'Written when the first attempt starts'
              : 'No attempt started, so nothing was launched'
        }}</span>
      </button>
    </h2>
    <div
      v-if="expanded && record && c"
      :id="bodyId"
      class="flex flex-col gap-14 rounded-6 border border-border bg-surface p-16"
      data-testid="launch-record"
    >
      <div class="flex flex-col gap-6">
        <span class="text-12 font-semibold text-text-2">Container</span>
        <dl class="grid grid-cols-[160px_minmax(0,1fr)] gap-x-16 gap-y-8 max-lg:grid-cols-1">
          <dt class="text-text-2">Image</dt>
          <dd>
            <span class="font-mono">{{ c.image }}</span>
            <span class="font-mono text-text-3"> ({{ shortDigest(c.digest) }})</span>
          </dd>
          <dt class="text-text-2">Hermes revision</dt>
          <dd class="font-mono">{{ shortRevision(c.hermes) }}</dd>
          <dt class="text-text-2">Network</dt>
          <dd class="font-mono">{{ c.network }}</dd>
          <dt class="text-text-2">User</dt>
          <dd class="font-mono">{{ c.user }}</dd>
          <dt class="text-text-2">Image filesystem</dt>
          <dd>{{ c.imageFilesystem }}</dd>
          <dt class="text-text-2">Limits</dt>
          <dd class="font-mono">{{ limits }}</dd>
          <dt class="text-text-2">Files</dt>
          <dd class="flex flex-col gap-2">
            <span v-for="mount in c.mounts" :key="mount.target" class="font-mono text-12 leading-20"
              >{{ mount.name }} <span class="text-text-3">→</span> {{ mount.target }}</span
            >
            <span class="text-12 text-text-3"
              >This attempt's own directories on the worker host, mounted at these container paths.
              A retry gets new ones.</span
            >
          </dd>
          <dt class="text-text-2">Disk cap</dt>
          <dd class="font-mono">{{ diskCap }}</dd>
          <dt class="text-text-2">Worker</dt>
          <dd class="font-mono">{{ worker }}</dd>
          <dt class="text-text-2">Skills</dt>
          <dd class="text-text-2"><RichSentence :text="skills" /></dd>
          <template v-if="skillLoading">
            <dt class="text-text-2">Skill loading</dt>
            <dd class="text-text-2" data-testid="launch-skill-loading">
              <RichSentence :text="skillLoading" />
            </dd>
          </template>
          <dt class="text-text-2">MCP servers</dt>
          <dd class="flex flex-col gap-4 text-text-2">
            <span v-if="!mcp.length">None in this configuration</span>
            <span v-for="(line, i) in mcp" :key="i"><RichSentence :text="line" /></span>
          </dd>
          <dt class="text-text-2">Home seeds</dt>
          <dd class="flex flex-col gap-2" data-testid="launch-home-seeds">
            <span v-if="!homeSeeds.length && !skippedSeeds.length" class="text-text-2"
              >None: the home's <code class="font-mono text-12">memories/</code> started empty</span
            >
            <span
              v-for="seed in homeSeeds"
              :key="seed.path"
              class="font-mono text-12 leading-20"
              :data-seed="seed.path"
              >{{ seed.path }} <span class="text-text-3">→</span> {{ seed.target }}
              <span class="text-text-3">· {{ seed.hash }}</span></span
            >
            <span
              v-for="path in skippedSeeds"
              :key="path"
              class="font-mono text-12 leading-20 text-text-3"
              :data-seed-skipped="path"
              >{{ path }} · left out</span
            >
            <span v-if="homeNote" class="text-12 text-text-3" data-testid="launch-home-memory"
              ><RichSentence :text="homeNote"
            /></span>
          </dd>
          <template v-if="backgroundReview">
            <dt class="text-text-2">Background review</dt>
            <dd class="flex flex-col gap-2 text-text-2" data-testid="launch-background-review">
              <span v-for="(line, i) in backgroundReview" :key="i"
                ><RichSentence :text="line"
              /></span>
            </dd>
          </template>
        </dl>
      </div>
      <div class="flex flex-col gap-4">
        <span class="text-12 font-semibold text-text-2">Command</span>
        <CodeBlock :code="record.command" copy copy-label="Copy command" label="Command" />
        <span v-if="record.commandNote" class="text-12 text-text-3"
          ><RichSentence :text="record.commandNote"
        /></span>
      </div>
      <div class="flex flex-col gap-4">
        <span class="text-12 font-semibold text-text-2"
          >Configuration file · <span class="font-mono">{{ record.configPath }}</span></span
        >
        <CodeBlock :code="record.configYaml" :label="record.configPath" />
        <span v-if="record.configNote" class="text-12 text-text-3"
          ><RichSentence :text="record.configNote"
        /></span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import type { LaunchRecordView } from '@/api/types/runs';
import { formatClock, formatCount, shortRevision, formatBytes, formatSha256 } from '@/lib/format';
import RichSentence from './RichSentence.vue';
import { shortDigest } from './inspectorFormat';

/**
 * Section 5, Launch record (RunInspector, RunInspectorMcp): what this attempt ran in,
 * collapsed by default, and opened by the header's jump link. The container (image and digest, the Hermes revision, network, user,
 * limits, mounts, disk cap, worker), the skills with their content hashes, the MCP servers and
 * where their secret values live, the exact command and the config.yaml written for the run.
 * Secrets never appear: the run token reads ‹run token, revoked› and an MCP value
 * `<from env NAME>`.
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
          <dt class="text-text-2">MCP servers</dt>
          <dd class="flex flex-col gap-4 text-text-2">
            <span v-if="!mcp.length">None in this configuration</span>
            <span v-for="(line, i) in mcp" :key="i"><RichSentence :text="line" /></span>
          </dd>
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

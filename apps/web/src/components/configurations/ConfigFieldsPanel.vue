<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useMediaQuery } from '@vueuse/core';
import { SKILL_LOADING_LABELS, SKILL_LOADING_OPTIONS } from '@hermes-evals/shared';
import BasePanel from '@/components/ui/BasePanel.vue';
import KeyValueList from '@/components/ui/KeyValueList.vue';
import type { KeyValueItem } from '@/components/ui/types';
import type { ConfigField, ConfigurationVersion, McpServerRef } from '@/api/types/configurations';
import { ROUTE_NAMES } from '@/router';
import { formatBytes, formatSha256 } from '@/lib/format';
import McpExposureNote from './McpExposureNote.vue';
import { hashTag, launchToolsets, launchToolsetsNote } from './configDisplay';

/**
 * A configuration version's fields, "as written into each run's config.yaml" (ConfigDetail ›
 * Fields): a two-column definition list. A field that differs from the configuration it was
 * duplicated from is tinted and says so ("differs from baseline"); an MCP server row carries
 * what the server exposes to the run, named from that very definition version (McpServerRef's
 * envNames and headers), so a version pinned to an older definition names its own. Skill
 * loading (Phase 6 P5) follows Skills: the mode and what it does, or that it has nothing to
 * load. Toolsets and Memory say what memory on and on-demand skills add at launch (Phase 6b
 * #12): the stored list is what the hash covers, the run gets those on top.
 */
const props = withDefaults(
  defineProps<{
    version: ConfigurationVersion;
    /** Fields that differ from `sourceName`'s version. */
    differs?: ConfigField[];
    sourceName?: string | null;
  }>(),
  { differs: () => [], sourceName: null },
);

const differ = (field: ConfigField): boolean => !!props.sourceName && props.differs.includes(field);
const differsNote = computed(() => (props.sourceName ? `differs from ${props.sourceName}` : ''));

const items = computed<KeyValueItem[]>(() => {
  const v = props.version;
  return [
    { key: 'model', label: 'Model', value: v.model, mono: true, highlight: differ('model') },
    {
      key: 'provider',
      label: 'Provider',
      value: v.provider,
      mono: true,
      highlight: differ('provider'),
    },
    { key: 'toolsets', label: 'Toolsets', highlight: differ('toolsets') },
    { key: 'memory', label: 'Memory', highlight: differ('memory') },
    { key: 'skills', label: 'Skills', highlight: differ('skills') },
    { key: 'skill_loading', label: 'Skill loading', highlight: differ('skill_loading') },
    { key: 'documents', label: 'Documents', highlight: differ('documents') },
    { key: 'mcp_servers', label: 'MCP servers', highlight: differ('mcp_servers') },
    { key: 'max_turns', label: 'Max turns', value: v.maxTurns, highlight: differ('max_turns') },
    {
      key: 'time_budget_s',
      label: 'Time budget',
      value: `${v.timeBudgetS} s`,
      highlight: differ('time_budget_s'),
    },
    { key: 'hash', label: 'Config hash' },
  ];
});

/** Two columns of rows from 1024px; one below, like every side-by-side block. */
const wide = useMediaQuery('(min-width: 1024px)');

/** One value line: its parts 6px apart, wrapping. */
const LINE = 'flex flex-wrap items-center gap-x-6 gap-y-4';

/** "env INVOICE_DB_URL · differs from baseline". */
function serverNote(m: McpServerRef): string {
  const env = m.transport === 'stdio' ? m.envNames : [];
  return [env.length ? `env ${env.join(', ')}` : '', differ('mcp_servers') ? differsNote.value : '']
    .filter(Boolean)
    .join(' · ');
}

const library = (tab: string) => ({ name: ROUTE_NAMES.resourcesTab, params: { tab } });

/** What memory on and on-demand skills add to the stored toolsets at launch (Phase 6b #12). */
const launchNote = computed(() => launchToolsetsNote(launchToolsets(props.version)));

/** "Each skill is loaded into the prompt at start (-s per skill)." for the version's mode. */
const loadingHelp = computed(
  () => SKILL_LOADING_OPTIONS.find((o) => o.id === props.version.skillLoading)?.description ?? '',
);
</script>

<template>
  <BasePanel title="Fields" meta="as written into each run's config.yaml">
    <KeyValueList :items="items" layout="rows" :columns="wide ? 2 : 1" :label-width="150">
      <template #value-model>
        <span :class="LINE">
          <span class="font-mono">{{ version.model }}</span>
          <span v-if="differ('model')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-provider>
        <span :class="LINE">
          <span class="font-mono">{{ version.provider }}</span>
          <span v-if="version.baseUrl" class="font-mono text-12 text-text-3">{{
            version.baseUrl
          }}</span>
          <span v-if="differ('provider')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-toolsets>
        <span :class="LINE">
          <span v-for="t in version.toolsets" :key="t" class="tag">{{ t }}</span>
          <span v-if="version.toolsets.length === 0" class="text-text-3">None</span>
          <span v-if="launchNote" class="text-12 text-text-3" data-testid="launch-toolsets">{{
            launchNote
          }}</span>
          <span v-if="differ('toolsets')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-memory>
        <span :class="LINE">
          <span>{{ version.memoryEnabled ? 'on' : 'off' }}</span>
          <span v-if="!version.memoryEnabled" class="text-12 text-text-3"
            >(runtime default is on)</span
          >
          <span v-else class="text-12 text-text-3">(adds the memory toolset at launch)</span>
          <span v-if="differ('memory')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-skills>
        <span :class="LINE">
          <span v-if="version.skills.length === 0" class="text-text-3">No added skills</span>
          <template v-for="s in version.skills" :key="s.skillId">
            <RouterLink :to="library('skills')" class="font-mono">{{ s.name }}</RouterLink>
            <span class="tag">{{ s.version }}</span>
            <span class="tag">{{ hashTag(s.contentHash) }}</span>
          </template>
          <span v-if="differ('skills')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-skill_loading>
        <span :class="LINE" data-testid="skill-loading">
          <span>{{ SKILL_LOADING_LABELS[version.skillLoading] }}</span>
          <span class="text-12 text-text-3">{{
            version.skills.length ? loadingHelp : '(no added skills to load)'
          }}</span>
          <span v-if="differ('skill_loading')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-documents>
        <span :class="LINE">
          <span v-if="version.documents.length === 0" class="text-text-3">None</span>
          <template v-for="d in version.documents" :key="d.documentId">
            <RouterLink :to="library('documents')" class="font-mono">{{ d.filename }}</RouterLink>
            <span class="tag">{{ formatBytes(d.sizeBytes) }}</span>
          </template>
          <span v-if="differ('documents')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-mcp_servers>
        <span v-if="version.mcpServers.length === 0" class="text-text-3">None</span>
        <div v-for="m in version.mcpServers" :key="m.versionId" class="flex flex-col gap-6">
          <span :class="LINE">
            <RouterLink :to="library('mcp')" class="font-mono">{{ m.name }}</RouterLink>
            <span class="tag">v{{ m.version }}</span>
            <span class="tag">{{ m.transport }}</span>
            <span v-if="serverNote(m)" class="text-12 text-text-3">{{ serverNote(m) }}</span>
          </span>
          <McpExposureNote
            :server="m"
            :env-names="m.envNames"
            :headers="m.headers.map((h) => h.header)"
          />
        </div>
      </template>
      <template #value-max_turns>
        <span :class="LINE">
          <span>{{ version.maxTurns }}</span>
          <span v-if="differ('max_turns')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-time_budget_s>
        <span :class="LINE">
          <span>{{ version.timeBudgetS }} s</span>
          <span v-if="differ('time_budget_s')" class="text-12 text-text-3">{{ differsNote }}</span>
        </span>
      </template>
      <template #value-hash>
        <span class="font-mono text-text-2" :title="`sha256:${version.configHash}`">{{
          formatSha256(version.configHash)
        }}</span>
      </template>
    </KeyValueList>
  </BasePanel>
</template>

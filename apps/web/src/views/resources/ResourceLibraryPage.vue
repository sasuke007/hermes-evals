<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ResourceTab } from '@/api/types/resources';
import PageContainer from '@/components/layout/PageContainer.vue';
import DocumentsTab from '@/components/resources/DocumentsTab.vue';
import McpServersTab from '@/components/resources/McpServersTab.vue';
import SecretsTab from '@/components/resources/SecretsTab.vue';
import SkillsTab from '@/components/resources/SkillsTab.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import TabNav from '@/components/ui/TabNav.vue';
import type { TabItem } from '@/components/ui/types';
import { urlOptional, useUrlState } from '@/composables/useUrlState';
import { ROUTE_NAMES } from '@/router';
import { useResourcesStore } from '@/stores/resources';

/**
 * Resources: what a configuration can include, one tab per kind (ResourcesSkills,
 * ResourcesDocuments, ResourcesMcp and ResourcesSecrets boards; Library states for empty,
 * loading and error). The header's one action follows the tab: Upload skill, Upload
 * document, Define MCP server, or Check again on Secrets. The tabs carry their counts.
 * The AppShell shows the model-access banner here too (UI_FLOWS 19 #4).
 */
const props = defineProps<{ tab: ResourceTab }>();

const store = useResourcesStore();
const url = useUrlState({ mcp: urlOptional() });
const skillUploadOpen = ref(false);
const documentUploadOpen = ref(false);

watch(
  () => props.tab,
  (tab) => void store.loadTab(tab),
  { immediate: true },
);

/**
 * The line under the title: the Skills board's for the three kinds a configuration includes
 * (the Documents and MCP boards draw none, but the tab row would then jump between tabs), the
 * Secrets board's on Secrets.
 */
const LIBRARY =
  'Things a configuration can include. Each upload is content-hashed, so a configuration always points at exact bytes.';
const DESCRIPTION: Record<ResourceTab, string> = {
  skills: LIBRARY,
  documents: LIBRARY,
  mcp: LIBRARY,
  secrets:
    'Secret values never pass through this app. It only shows which names are set for the worker and egress.',
};

const tabs = computed<TabItem[]>(() => {
  const counts = store.counts;
  const tab = (key: ResourceTab, label: string, count: number | undefined): TabItem => ({
    key,
    label,
    to: { name: ROUTE_NAMES.resourcesTab, params: { tab: key } },
    count: count ?? null,
  });
  return [
    tab('skills', 'Skills', counts?.skills),
    tab('documents', 'Documents', counts?.documents),
    tab('mcp', 'MCP servers', counts?.mcpServers),
    tab('secrets', 'Secrets', counts?.secrets),
  ];
});
</script>

<template>
  <PageContainer>
    <PageHeader title="Resources" :description="DESCRIPTION[tab]">
      <template #actions>
        <button
          v-if="tab === 'skills'"
          type="button"
          class="btn primary"
          @click="skillUploadOpen = true"
        >
          Upload skill
        </button>
        <button
          v-else-if="tab === 'documents'"
          type="button"
          class="btn primary"
          @click="documentUploadOpen = true"
        >
          Upload document
        </button>
        <button
          v-else-if="tab === 'mcp'"
          type="button"
          class="btn primary"
          @click="url.mcp.value = 'new'"
        >
          Define MCP server
        </button>
        <button
          v-else
          type="button"
          class="btn"
          :disabled="store.checking"
          :aria-busy="store.checking ? 'true' : undefined"
          @click="store.checkSecrets()"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
            :class="{ 'animate-spin': store.checking }"
          >
            <path
              d="M11.5 7A4.5 4.5 0 1 1 9.8 3.5M11.5 2v3h-3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Check again
        </button>
      </template>
    </PageHeader>
    <TabNav :tabs="tabs" label="Resource kinds" />

    <SkillsTab v-if="tab === 'skills'" v-model:upload-open="skillUploadOpen" />
    <DocumentsTab v-else-if="tab === 'documents'" v-model:upload-open="documentUploadOpen" />
    <McpServersTab v-else-if="tab === 'mcp'" />
    <SecretsTab v-else />
  </PageContainer>
</template>

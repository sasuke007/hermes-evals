<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import ConfigCompareWith from '@/components/configurations/ConfigCompareWith.vue';
import ConfigFieldsPanel from '@/components/configurations/ConfigFieldsPanel.vue';
import ConfigUsageTable from '@/components/configurations/ConfigUsageTable.vue';
import ConfigVersionHistory from '@/components/configurations/ConfigVersionHistory.vue';
import PageContainer from '@/components/layout/PageContainer.vue';
import BasePanel from '@/components/ui/BasePanel.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import { formatDateTime, plural } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';
import { useConfigurationsStore } from '@/stores/configurations';

/**
 * Configuration detail (ConfigDetail board; UI_FLOWS 10.2): the fields of the version shown
 * as a two-column list, the version history, and every experiment that used it with its pass
 * rate and verdict there. `?version=<n>` ("view as of this experiment", or a row of the
 * history) shows an older, frozen version. Edit opens the form on the latest version;
 * Duplicate opens it prefilled; Compare with… opens ConfigDiffTable against another
 * configuration or version. After a save it says "Saved as version 2" once.
 */
const props = defineProps<{ configurationId: string; version?: number }>();
const store = useConfigurationsStore();

const detail = computed(() => store.detail(props.configurationId, props.version));
const state = computed(() => store.detailState(props.configurationId, props.version));
const name = computed(() => detail.value?.name ?? store.nameOf(props.configurationId));

function load(): void {
  void store.loadDetail(props.configurationId, props.version);
}
watch(() => [props.configurationId, props.version], load, { immediate: true });

const comparing = ref(false);
watch(
  () => props.configurationId,
  () => (comparing.value = false),
);
function openCompare(): void {
  comparing.value = !comparing.value;
  if (comparing.value && !store.listState.loaded) void store.loadList();
}

onMounted(() => {
  void store.loadMcpExposure();
});

/** "Saved as version 2." once, after the form routes here. */
const saved = ref(store.takeSaved(props.configurationId));
const savedText = computed(() => {
  const s = saved.value;
  if (!s) return null;
  return s.createdNewVersion ? `Saved as version ${s.version}.` : `Saved version ${s.version}.`;
});

const breadcrumbs = computed(() => [
  { label: 'Configurations', to: { name: ROUTE_NAMES.configurations } },
  { label: name.value ?? 'Configuration' },
]);
const shown = computed(() => detail.value?.shown ?? null);
const versionTag = computed(() =>
  shown.value ? `v${shown.value.version}${shown.value.latest ? ' · latest' : ''}` : null,
);
const source = computed(() => detail.value?.duplicatedFrom ?? null);
const sourceRoute = computed(() =>
  source.value
    ? {
        name: ROUTE_NAMES.configuration,
        params: { id: source.value.configurationId },
        query: { version: String(source.value.version) },
      }
    : null,
);
const latestRoute = computed(() => ({
  name: ROUTE_NAMES.configuration,
  params: { id: props.configurationId },
}));
</script>

<template>
  <PageContainer variant="detail">
    <PageHeader :title="name ?? 'Configuration'" :breadcrumbs="breadcrumbs" mono>
      <template v-if="versionTag" #title-extra>
        <span class="tag">{{ versionTag }}</span>
      </template>
      <template v-if="detail" #meta>
        <p class="text-12 text-text-3" data-testid="detail-meta">
          Created {{ formatDateTime(detail.createdAt) }}
          <template v-if="source && sourceRoute">
            by duplicating
            <RouterLink :to="sourceRoute" class="font-mono">{{ source.name }}</RouterLink>
            v{{ source.version }}
          </template>
          · used in {{ plural(detail.usedIn.length, 'experiment') }}
        </p>
      </template>
      <template #actions>
        <button
          type="button"
          class="btn"
          :aria-expanded="comparing ? 'true' : 'false'"
          :disabled="!detail"
          @click="openCompare"
        >
          Compare with…
        </button>
        <RouterLink
          class="btn"
          :to="{ name: ROUTE_NAMES.configurationNew, query: { from: configurationId } }"
          >Duplicate</RouterLink
        >
        <RouterLink
          class="btn primary"
          :to="{ name: ROUTE_NAMES.configurationEdit, params: { id: configurationId } }"
          >Edit</RouterLink
        >
      </template>
    </PageHeader>

    <div
      v-if="savedText"
      role="status"
      class="flex items-center gap-8 rounded-6 border border-pass bg-pass-soft px-14 py-10 text-pass-text"
      data-testid="saved-notice"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="flex-none">
        <path
          d="M2.5 7.5l3 3 6-6.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="font-medium">{{ savedText }}</span>
    </div>

    <ErrorBanner
      v-if="state.error && !detail"
      :title="`Could not load ${name ?? 'this configuration'}`"
      :detail="state.error"
      retry-label="Retry"
      @retry="load"
    />

    <template v-else-if="!detail">
      <BasePanel title="Fields" aria-busy="true" data-testid="detail-loading">
        <div class="p-16">
          <SkeletonRows
            :columns="[{ width: ['40%', '95%', '80%', '60%'] }]"
            layout="lines"
            :rows="5"
          />
        </div>
      </BasePanel>
    </template>

    <template v-else>
      <ErrorBanner
        v-if="shown && !shown.latest"
        tone="info"
        :title="`Viewing version ${shown.version}, frozen.`"
        :detail="`Experiments that used it ran with these fields, and they never change. The latest version is ${detail.latest.version}.`"
        data-testid="older-version"
      >
        <template #actions>
          <RouterLink class="btn sm" :to="latestRoute">Show the latest</RouterLink>
        </template>
      </ErrorBanner>

      <ConfigCompareWith
        v-if="comparing"
        :detail="detail"
        :others="store.list"
        @close="comparing = false"
      />

      <ConfigFieldsPanel
        :version="detail.shown"
        :differs="detail.differsFromSource"
        :source-name="source?.name ?? null"
        :exposure="store.mcpExposure"
      />

      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(520px,100%),1fr))] items-start gap-16">
        <ConfigVersionHistory
          :configuration-id="configurationId"
          :versions="detail.versions"
          :shown="detail.shown.version"
        />
        <ConfigUsageTable :used-in="detail.usedIn" />
      </div>
    </template>
  </PageContainer>
</template>

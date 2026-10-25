<script setup lang="ts">
import { computed, ref } from 'vue';
import ProviderStatusRow from '@/components/model-access/ProviderStatusRow.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import type { SkeletonColumn } from '@/components/ui/types';
import { useProvidersStore } from '@/stores/providers';
import SystemSection from './SystemSection.vue';

/**
 * System › Model access: one ProviderStatusRow per provider GET /providers lists (Nous Portal
 * first, then the API-key providers), and under the table which configurations use each.
 * There is no input anywhere: keys are never accepted or stored in the UI. A first load that
 * fails replaces the table with the error; a failed refresh keeps the last answer under it.
 */
const providers = useProvidersStore();

/** Configuration names shown per provider before "and N more". */
const USED_BY_SHOWN = 5;
const showAllUsedBy = ref(false);

const SKELETON: SkeletonColumn[] = [
  { width: 90 },
  { width: 150 },
  { width: 80, height: 16 },
  { width: ['70%', '55%'] },
  { width: 130, height: 16 },
];

/** "Used by: baseline, with-skill, with-mcp (all Nous Portal)." One line per provider in use. */
const usedLines = computed(() => {
  const used = providers.usedProviders;
  return used.map((p) => {
    const names = showAllUsedBy.value ? p.usedBy : p.usedBy.slice(0, USED_BY_SHOWN);
    return {
      id: p.id,
      names,
      more: p.usedBy.length - names.length,
      owner: used.length === 1 ? `all ${p.name}` : p.name,
    };
  });
});
const truncated = computed(() => usedLines.value.some((line) => line.more > 0));

const firstLoad = computed(() => !providers.loaded);
</script>

<template>
  <SystemSection id="model-access" title="Model access">
    <ErrorBanner
      v-if="providers.error"
      title="Could not load model access"
      :detail="providers.error"
      :hint="firstLoad ? 'Check that the api service is running: docker compose ps api.' : null"
      retry-label="Retry"
      @retry="providers.load()"
    />
    <div
      v-if="!(firstLoad && providers.error)"
      class="tbl"
      :aria-busy="firstLoad ? 'true' : undefined"
    >
      <table class="dt loose static" aria-labelledby="model-access">
        <thead>
          <tr>
            <th class="w-150">Provider</th>
            <th class="w-220">Authenticates with</th>
            <th class="w-140">Status</th>
            <th>Detail</th>
            <th class="w-240">Action</th>
          </tr>
        </thead>
        <tbody>
          <SkeletonRows v-if="firstLoad" :columns="SKELETON" :rows="2" />
          <template v-else>
            <ProviderStatusRow
              v-for="provider in providers.providers"
              :key="provider.id"
              :provider="provider"
              layout="table"
            />
          </template>
        </tbody>
      </table>
    </div>
    <template v-if="!firstLoad">
      <p
        v-for="line in usedLines"
        :key="line.id"
        class="text-12 leading-16 text-text-3"
        :data-used-by="line.id"
      >
        Used by:
        <template v-for="(name, i) in line.names" :key="name"
          ><code>{{ name }}</code
          >{{ i < line.names.length - 1 ? ', ' : '' }}</template
        ><template v-if="line.more > 0"> and {{ line.more }} more</template> ({{ line.owner }}).
      </p>
      <button
        v-if="truncated || showAllUsedBy"
        type="button"
        class="linkbtn self-start text-12"
        :aria-expanded="showAllUsedBy ? 'true' : 'false'"
        data-testid="used-by-toggle"
        @click="showAllUsedBy = !showAllUsedBy"
      >
        {{ showAllUsedBy ? 'Show fewer' : 'Show every configuration' }}
      </button>
    </template>
  </SystemSection>
</template>

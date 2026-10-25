<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { SecretExposure, SecretReference, SecretRow } from '@/api/types/resources';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { SkeletonColumn } from '@/components/ui/types';
import { TONE_CLASSES, type Tone } from '@/lib/statusTones';
import { ROUTE_NAMES } from '@/router';
import SystemSection from './SystemSection.vue';

/**
 * System › Secrets: the names MCP servers reference, whether the service that reads each has
 * it, and who can read the value. Names only: values are never shown, typed or stored here.
 * Resources › Secrets is where they are managed (how to set one, Check again).
 */
const props = withDefaults(
  defineProps<{
    secrets: SecretRow[] | null;
    error?: string | null;
  }>(),
  { error: null },
);
defineEmits<{ retry: [] }>();

/** References listed per name before "and N more". */
const REFS_SHOWN = 2;

const EXPOSURE: Record<SecretExposure, { label: string; tone: Tone }> = {
  readable_by_agent: { label: 'Readable by the agent', tone: 'ung' },
  egress_only: { label: 'Added by egress · never in the run', tone: 'que' },
};

const SKELETON: SkeletonColumn[] = [
  { width: [130, 150] },
  { width: 50, height: 16 },
  { width: ['60%', '70%'] },
  { width: [140, 200], height: 16 },
  { width: 170 },
];

/** "stdio MCP server invoice-db, env" · "http MCP server vendor-api, header Authorization". */
function reference(ref: SecretReference): string {
  return ref.via === 'header'
    ? `http MCP server ${ref.name}, header ${ref.header ?? ''}`
    : `stdio MCP server ${ref.name}, env`;
}

const rows = computed(() =>
  (props.secrets ?? []).map((row) => {
    const shown = row.referencedBy.slice(0, REFS_SHOWN).map(reference);
    const more = row.referencedBy.length - shown.length;
    return {
      key: `${row.name}:${row.source}`,
      name: row.name,
      set: row.set,
      usedBy: more > 0 ? `${shown.join('; ')} and ${more} more` : shown.join('; '),
      usedByTitle: row.referencedBy.map(reference).join('\n'),
      exposure: EXPOSURE[row.exposure],
    };
  }),
);
const loading = computed(() => props.secrets === null && !props.error);
const secretsTo = { name: ROUTE_NAMES.resourcesTab, params: { tab: 'secrets' } };
</script>

<template>
  <SystemSection
    id="secrets"
    title="Secrets"
    caption="names only · values are never shown, typed or stored here"
  >
    <ErrorBanner
      v-if="error"
      title="Could not load secrets"
      :detail="error"
      retry-label="Retry"
      @retry="$emit('retry')"
    />
    <div v-if="!(error && secrets === null)" class="tbl" :aria-busy="loading ? 'true' : undefined">
      <table class="dt loose static" aria-labelledby="secrets">
        <thead>
          <tr>
            <th class="w-220">Secret</th>
            <th class="w-140">Status</th>
            <th>Used by</th>
            <th class="w-300">Exposure</th>
            <th class="w-240"><span class="sr-only">Manage</span></th>
          </tr>
        </thead>
        <tbody>
          <SkeletonRows v-if="loading" :columns="SKELETON" :rows="2" />
          <tr v-else-if="rows.length === 0">
            <td colspan="5" class="p-0">
              <EmptyState
                :panel="false"
                title="No secrets referenced"
                body="A name appears here when an MCP server lists it as an environment variable or header. The app then shows whether it is set, never its value."
                :action="{
                  label: 'Define MCP server',
                  to: { name: ROUTE_NAMES.resourcesTab, params: { tab: 'mcp' } },
                }"
              />
            </td>
          </tr>
          <tr v-for="row in rows" v-else :key="row.key" :data-secret="row.name">
            <td class="font-mono font-semibold">{{ row.name }}</td>
            <td><StatusChip kind="secret" :status="row.set ? 'set' : 'not_set'" /></td>
            <td class="text-text-2" :title="row.usedByTitle">{{ row.usedBy }}</td>
            <td>
              <span class="chip" :class="TONE_CLASSES[row.exposure.tone].chip">{{
                row.exposure.label
              }}</span>
            </td>
            <td>
              <RouterLink :to="secretsTo">Manage in Resources › Secrets</RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </SystemSection>
</template>

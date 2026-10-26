<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { McpServerRow } from '@/api/types/resources';
import BaseTag from '@/components/ui/BaseTag.vue';
import DataTable from '@/components/ui/DataTable.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { DataTableColumn } from '@/components/ui/types';
import { urlOptional, useUrlState } from '@/composables/useUrlState';
import { formatDateTime } from '@/lib/format';
import { useResourcesStore } from '@/stores/resources';
import { useRevealFlashedRow } from './revealFlashedRow';
import { endpointOf, headerNamesText, toolCounts } from './format';
import McpServerForm from './McpServerForm.vue';
import UsedByLink from './UsedByLink.vue';

/**
 * Resources › MCP servers (ResourcesMcp board): each server's latest version, how it is
 * reached, its tool filter and who uses it. A server never tested since it was saved carries
 * an "untested" tag; a failed last test, a failed chip. The form opens under the table:
 * ?mcp=new from "Define MCP server", ?mcp=<id> from a row. A saved server's row flashes.
 */
const store = useResourcesStore();
useRevealFlashedRow(() => store.flashId);
const route = useRoute();
const url = useUrlState({ mcp: urlOptional() });

const columns: DataTableColumn<McpServerRow>[] = [
  { key: 'name', label: 'Name', skeleton: [90, 80] },
  { key: 'transport', label: 'Transport', skeleton: 40 },
  // Not fields of the row: `format` gives their text (and keeps them out of the missing style).
  { key: 'endpoint', label: 'Endpoint or command', skeleton: [130, 240], format: endpointOf },
  { key: 'filter', label: 'Tool filter', skeleton: [220, 60], format: (row) => filterText(row) },
  { key: 'definedAt', label: 'Defined', skeleton: 80 },
  { key: 'usedBy', label: 'Used by', align: 'right', skeleton: 90 },
];

const servers = computed(() => store.mcpServers);
const firstLoadFailed = computed(() => !!servers.value.error && !servers.value.loaded);
const editing = computed(() =>
  url.mcp.value && url.mcp.value !== 'new' ? (servers.value.byId[url.mcp.value] ?? null) : null,
);
/** ?mcp=<id> of a server that is not in the list (yet, or any more). */
const unknownServer = computed(
  () =>
    !!url.mcp.value && url.mcp.value !== 'new' && servers.value.loaded && editing.value === null,
);
const formOpen = computed(() => url.mcp.value === 'new' || editing.value !== null);

const editLink = (row: McpServerRow) => ({ query: { ...route.query, mcp: row.id } });
function filterText(row: McpServerRow): string {
  const f = filterOf(row);
  const parts = [f.include && `include ${f.include}`, f.exclude && `exclude ${f.exclude}`];
  return parts.filter(Boolean).join(' · ') || 'all tools';
}
function filterOf(row: McpServerRow) {
  const counts = toolCounts(row.lastTest);
  return {
    include: row.include.join(', '),
    exclude: row.exclude.join(', '),
    share: counts && row.include.length ? `· ${counts.included} of ${counts.total} tools` : null,
  };
}

function open(row: McpServerRow): void {
  url.mcp.value = row.id;
}
function close(): void {
  url.mcp.value = null;
}
</script>

<template>
  <ErrorBanner
    v-if="firstLoadFailed"
    title="Could not load MCP servers"
    :detail="servers.error"
    retry-label="Retry"
    @retry="store.loadMcpServers()"
  />
  <div
    v-else-if="servers.loaded && store.mcpServerRows.length === 0 && !formOpen"
    class="flex flex-col items-center gap-8 rounded-6 border border-border bg-surface px-24 py-36 text-center"
    data-testid="empty-state"
  >
    <div class="text-15 font-semibold">No MCP servers defined</div>
    <p class="max-w-460 text-text-2">
      Define a server once, then include it in configurations. Use stdio for servers that should
      start fresh in every run, or http for servers you host.
    </p>
    <RouterLink class="btn primary mt-4" :to="{ query: { ...route.query, mcp: 'new' } }"
      >Define MCP server</RouterLink
    >
  </div>
  <DataTable
    v-else-if="!(servers.loaded && store.mcpServerRows.length === 0)"
    :columns="columns"
    :rows="store.mcpServerRows"
    :loading="servers.loading && !servers.loaded"
    :error="servers.error"
    error-title="Could not load MCP servers"
    label="MCP servers"
    table-class="h44"
    clickable
    :skeleton-rows="2"
    :row-class="(row) => (row.id === store.flashId ? 'animate-flash' : undefined)"
    @row-click="open"
    @retry="store.loadMcpServers()"
  >
    <template #cell-name="{ row }">
      <span class="inline-flex items-center gap-8">
        <RouterLink
          :to="editLink(row)"
          class="font-mono font-semibold text-text"
          :aria-label="`${row.name}: edit the MCP server`"
          >{{ row.name }}</RouterLink
        >{{ ' '
        }}<BaseTag v-if="row.lastTest.status === 'untested'" :mono="false">untested</BaseTag>
        <StatusChip
          v-else-if="row.lastTest.status !== 'passed'"
          kind="mcpTest"
          :status="row.lastTest.status"
          size="sm"
        />
      </span>
    </template>
    <template #cell-transport="{ row }"
      ><BaseTag>{{ row.transport }}</BaseTag></template
    >
    <template #cell-endpoint="{ row }">
      <span class="font-mono text-12">{{ endpointOf(row) }}</span>
      <span v-if="row.transport === 'http' && row.headers.length" class="text-12 text-text-3">
        · header {{ headerNamesText(row.headers) }}</span
      >
    </template>
    <template #cell-filter="{ row }">
      <span class="text-text-2"
        ><template v-if="row.include.length"
          >include <span class="font-mono text-text">{{ filterOf(row).include }}</span></template
        ><template v-if="row.exclude.length"
          >{{ row.include.length ? ' · ' : '' }}exclude
          <span class="font-mono text-text">{{ filterOf(row).exclude }}</span></template
        ><template v-if="!row.include.length && !row.exclude.length">all tools</template
        ><span v-if="filterOf(row).share" class="text-12 text-text-3">{{
          ` ${filterOf(row).share}`
        }}</span></span
      >
    </template>
    <template #cell-definedAt="{ row }">
      <span class="text-text-2">{{ formatDateTime(row.definedAt) }}</span>
    </template>
    <template #cell-usedBy="{ row }"><UsedByLink :links="row.usedBy" zero="number" /></template>
  </DataTable>

  <ErrorBanner
    v-if="unknownServer"
    tone="warning"
    title="No such MCP server"
    :detail="`There is no MCP server with the id ${url.mcp.value}.`"
    retry-label="Close"
    @retry="close"
  />
  <McpServerForm
    v-if="formOpen"
    :key="editing?.id ?? 'new'"
    :server="editing"
    @saved="close"
    @cancel="close"
  />
</template>

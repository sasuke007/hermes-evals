<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import EmptyState from '@/components/ui/EmptyState.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import type { SkeletonColumn } from '@/components/ui/types';
import type { ConfigurationListRow } from '@/api/types/configurations';
import { formatDateTime, plural } from '@/lib/format';
import { ROUTE_NAMES } from '@/router';

/**
 * The configuration list (ConfigList board): one row per configuration at its latest
 * version, with a checkbox to pick it for Compare. Clicking a row (or Enter on it) opens the
 * detail; a picked row is tinted. Loading draws skeleton rows at the real columns; with no
 * configurations the header stays and the body explains what one is (LibraryStates ›
 * Configurations · empty), or what the #empty slot says (no match for the page's filter).
 * Skills loaded on demand (Phase 6 P5) carry an "on demand" tag.
 */
const props = withDefaults(
  defineProps<{
    rows: ConfigurationListRow[];
    loading?: boolean;
  }>(),
  { loading: false },
);
const selected = defineModel<string[]>('selected', { default: () => [] });
const router = useRouter();

/** Toolsets beyond this many collapse into a "+N" tag. */
const TOOLSET_TAGS = 3;

const detailRoute = (row: ConfigurationListRow) => ({
  name: ROUTE_NAMES.configuration,
  params: { id: row.id },
});

const view = computed(() =>
  props.rows.map((row) => {
    const v = row.latest;
    return {
      row,
      selected: selected.value.includes(row.id),
      toolsets: v.toolsets.slice(0, TOOLSET_TAGS),
      moreToolsets: v.toolsets.slice(TOOLSET_TAGS),
      skills: v.skills.map((s) => s.name).join(', '),
      onDemand: v.skills.length > 0 && v.skillLoading === 'on_demand',
      servers: v.mcpServers.map((m) => m.name).join(', '),
      documents: v.documents.length,
    };
  }),
);

function toggle(id: string): void {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((s) => s !== id)
    : [...selected.value, id];
}

function open(row: ConfigurationListRow, event: MouseEvent | KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('a, button, input, label')) return;
  void router.push(detailRoute(row));
}

const skeleton: SkeletonColumn[] = [
  { width: 14, height: 14 },
  { width: [110, 90, 100] },
  140,
  50,
  { width: 90, height: 16 },
  30,
  { width: [80, 110, 60] },
  { width: [60, 40, 80] },
  { width: 16, align: 'right' },
  90,
  { width: 80, align: 'right' },
];
</script>

<template>
  <div class="tbl">
    <table class="dt h40 clickable" aria-label="Configurations" :aria-busy="loading || undefined">
      <thead>
        <tr>
          <th class="w-36"><span class="sr-only">Select</span></th>
          <th>Name</th>
          <th>Model</th>
          <th>Provider</th>
          <th>Toolsets</th>
          <th>Memory</th>
          <th>Skills</th>
          <th>MCP servers</th>
          <th class="text-right">Docs</th>
          <th>Created</th>
          <th class="text-right">Used in</th>
        </tr>
      </thead>
      <tbody v-if="loading">
        <SkeletonRows :columns="skeleton" :rows="3" />
      </tbody>
      <tbody v-else-if="rows.length === 0">
        <tr class="hover:[&>td]:bg-transparent">
          <td colspan="11" class="cursor-default whitespace-normal">
            <slot name="empty">
              <EmptyState
                title="No configurations yet"
                body="A configuration records how the agent is set up: model, provider, toolsets, memory, skills, documents and MCP servers. An experiment compares two or more of them."
                :panel="false"
                :action="{ label: 'New configuration', to: { name: ROUTE_NAMES.configurationNew } }"
              />
            </slot>
          </td>
        </tr>
      </tbody>
      <tbody v-else>
        <tr
          v-for="item in view"
          :key="item.row.id"
          :class="{ '[&>td]:bg-accent-soft': item.selected }"
          :data-selected="item.selected ? 'true' : undefined"
          :data-id="item.row.id"
          tabindex="0"
          @click="open(item.row, $event)"
          @keydown.enter="open(item.row, $event)"
        >
          <td class="w-36">
            <input
              type="checkbox"
              class="size-14 accent-accent"
              :checked="item.selected"
              :aria-label="`Select ${item.row.name} for comparison`"
              @change="toggle(item.row.id)"
            />
          </td>
          <td>
            <RouterLink :to="detailRoute(item.row)" class="font-mono font-semibold text-text">{{
              item.row.name
            }}</RouterLink
            >{{ ' ' }}<span class="tag">v{{ item.row.latest.version }}</span>
          </td>
          <td class="font-mono text-12">{{ item.row.latest.model }}</td>
          <td class="font-mono text-12">{{ item.row.latest.provider }}</td>
          <td>
            <div class="flex gap-4">
              <span v-for="t in item.toolsets" :key="t" class="tag">{{ t }}</span>
              <span
                v-if="item.moreToolsets.length"
                class="tag"
                :title="item.moreToolsets.join(', ')"
                >+{{ item.moreToolsets.length }}</span
              >
              <span v-if="item.row.latest.toolsets.length === 0" class="text-text-3">none</span>
            </div>
          </td>
          <td class="text-text-2">{{ item.row.latest.memoryEnabled ? 'on' : 'off' }}</td>
          <td>
            <span v-if="item.skills" class="flex items-center gap-6">
              <span class="block max-w-240 truncate font-mono text-12" :title="item.skills">{{
                item.skills
              }}</span>
              <span
                v-if="item.onDemand"
                class="tag font-sans whitespace-nowrap"
                title="Skill loading: on demand (installed for the agent to find)"
                data-testid="on-demand"
                >on demand</span
              >
            </span>
            <span v-else class="font-mono text-text-3">—</span>
          </td>
          <td>
            <span
              v-if="item.servers"
              class="block max-w-240 truncate font-mono text-12"
              :title="item.servers"
              >{{ item.servers }}</span
            >
            <span v-else class="font-mono text-text-3">—</span>
          </td>
          <td class="text-right" :class="{ 'text-text-3': item.documents === 0 }">
            {{ item.documents }}
          </td>
          <td class="text-text-2">{{ formatDateTime(item.row.createdAt) }}</td>
          <td class="text-right" :class="{ 'text-text-3': item.row.usedInExperiments === 0 }">
            {{ plural(item.row.usedInExperiments, 'experiment') }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

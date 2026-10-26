<script setup lang="ts">
import { computed } from 'vue';
import type { McpServerRef } from '@/api/types/configurations';

/**
 * What an MCP server in a configuration exposes to the run (MCP secrets: what the agent can
 * read). A stdio server runs inside the run's container, so the agent can read its
 * environment variables: the amber caution, information only, never a blocker (ConfigForm ›
 * MCP servers, ConfigDetail › with-mcp). An http server is reached through egress, which adds
 * its headers on the way, so the run never sees their values: a neutral line.
 * The names are the definition version's own (McpServerRef, the form options), so a
 * configuration pinned to an older version names what that version reads. `envNames` /
 * `headers` null: not known, and the note says so without names.
 */
const props = withDefaults(
  defineProps<{
    server: Pick<McpServerRef, 'name' | 'transport'>;
    envNames?: string[] | null;
    headers?: string[] | null;
    /** The form adds what to do about it: use scoped or throwaway values. */
    guidance?: boolean;
  }>(),
  { envNames: null, headers: null, guidance: false },
);

const stdio = computed(() => props.server.transport === 'stdio');
const names = computed(() => (stdio.value ? props.envNames : props.headers));
/** Joins code-set names: A · A and B · A, B and C. */
const parts = computed(() =>
  (names.value ?? []).map((name, i, all) => ({
    name,
    sep: i === 0 ? '' : i === all.length - 1 ? ' and ' : ', ',
  })),
);
</script>

<template>
  <div
    v-if="stdio"
    role="note"
    class="flex items-start gap-8 rounded-4 border border-ung bg-ung-soft px-8 py-6 text-12 leading-18"
    data-testid="mcp-exposure"
    data-transport="stdio"
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      aria-hidden="true"
      class="mt-3 flex-none text-ung-text"
    >
      <path
        d="M7 1.6l5.6 9.8H1.4z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
      <path
        d="M7 5.4v2.8M7 9.9h.01"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
    <span>
      <code>{{ server.name }}</code> runs inside the run's container.
      <template v-if="envNames === null"> The agent can read its environment variables.</template>
      <template v-else-if="parts.length">
        The agent can read
        <template v-for="p in parts" :key="p.name"
          >{{ p.sep }}<code>{{ p.name }}</code></template
        >.
      </template>
      <span v-if="guidance && (envNames === null || parts.length)" class="text-text-2">
        {{
          parts.length === 1
            ? 'Use a scoped or throwaway value: anything the server can use, the agent can use too.'
            : 'Use scoped or throwaway values: anything the server can use, the agent can use too.'
        }}</span
      >
    </span>
  </div>
  <div
    v-else
    role="note"
    class="flex items-start gap-8 rounded-4 border border-border bg-surface-2 px-8 py-6 text-12 leading-18 text-text-2"
    data-testid="mcp-exposure"
    data-transport="http"
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden="true"
      class="mt-3 flex-none text-accent"
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M8 7.2v4M8 4.8h.01"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
    <span>
      <code class="text-text">{{ server.name }}</code> is reached through egress<template
        v-if="headers === null"
        >, which adds its headers on the way to the server. The run never sees their
        values.</template
      ><template v-else-if="parts.length"
        >, which adds
        <template v-for="p in parts" :key="p.name"
          >{{ p.sep }}<code>{{ p.name }}</code></template
        >
        on the way to the server. The run never sees
        {{ parts.length === 1 ? 'its value' : 'their values' }}.</template
      ><template v-else>.</template>
    </span>
  </div>
</template>

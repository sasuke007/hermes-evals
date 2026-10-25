<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { McpServerRow } from '@/api/types/resources';
import { ROUTE_NAMES } from '@/router';

/**
 * What saving an edited MCP server does (ResourcesMcp board, edit mode): a server a
 * configuration uses is frozen, so saving creates its next version and the configurations
 * keep theirs; one nobody uses is changed in place (the API's rule, plan 5.3).
 */
defineProps<{ server: McpServerRow }>();
</script>

<template>
  <div
    class="mx-20 mt-14 flex items-start gap-10 rounded-6 border border-border-strong bg-accent-soft px-12 py-10"
    role="status"
    data-testid="version-notice"
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      class="mt-2 flex-none text-accent"
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M8 7.2v4M8 4.8h.01"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
    <span v-if="server.frozen" class="text-text-2"
      ><b class="text-text"
        >Saving creates version {{ server.version + 1 }}. Configurations that use version
        {{ server.version }} keep it.</b
      >
      <template v-if="server.usedBy.length"
        >{{ ' ' }}<span class="font-mono">{{ server.name }}</span> v{{ server.version }} is used by
        <template v-for="(link, i) in server.usedBy" :key="link.configurationId"
          >{{ i > 0 ? ', ' : ''
          }}<RouterLink
            class="font-mono"
            :to="{ name: ROUTE_NAMES.configuration, params: { id: link.configurationId } }"
            >{{ link.name }}</RouterLink
          ></template
        >.</template
      ></span
    >
    <span v-else class="text-text-2"
      ><b class="text-text">Saving changes version {{ server.version }} in place.</b>{{ ' '
      }}<span class="font-mono">{{ server.name }}</span> v{{ server.version }} is not used by any
      configuration yet.</span
    >
  </div>
</template>

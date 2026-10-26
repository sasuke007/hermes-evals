<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { McpServerInput } from '@/api/types/resources';
import BaseInput from '@/components/ui/BaseInput.vue';
import { ROUTE_NAMES } from '@/router';
import HeaderPairsInput from './HeaderPairsInput.vue';
import McpFormRow from './McpFormRow.vue';

/**
 * The http row of the MCP server form: the URL and the header names, each with the variable
 * egress reads its value from and an optional prefix ("Bearer "), and the note that the run
 * never sees those values.
 */
withDefaults(defineProps<{ errors?: Partial<Record<string, string>>; idPrefix: string }>(), {
  errors: () => ({}),
});
const url = defineModel<string>('url', { required: true });
const headers = defineModel<McpServerInput['headers']>('headers', { required: true });

const secretsTab = { name: ROUTE_NAMES.resourcesTab, params: { tab: 'secrets' } };
</script>

<template>
  <McpFormRow label="Endpoint">
    <div class="flex max-w-640 flex-col gap-12">
      <BaseInput
        v-model="url"
        label="URL"
        mono
        placeholder="https://mcp.internal.example:8443/mcp"
        :error="errors.url"
      />
      <div class="flex flex-col gap-4">
        <span class="text-12 leading-20 font-medium text-text-2">Header names (optional)</span>
        <HeaderPairsInput
          v-model="headers"
          :invalid="!!errors.headers"
          :described-by="errors.headers ? `${idPrefix}-headers-error` : null"
        />
        <p v-if="errors.headers" :id="`${idPrefix}-headers-error`" class="text-12 text-fail-text">
          {{ errors.headers }}
        </p>
        <span class="text-12 text-text-3" data-testid="prefix-hint"
          >An optional prefix, such as <code>Bearer</code>, is written before the value, so
          <code>.env</code> holds the raw token.</span
        >
        <div
          class="flex items-start gap-8 rounded-4 border border-border bg-surface-2 px-10 py-8"
          role="note"
          data-testid="http-note"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
            class="mt-3 flex-none text-text-3"
          >
            <rect
              x="3"
              y="6.2"
              width="8"
              height="5.8"
              rx="1"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
            />
            <path
              d="M4.8 6.2V4.5a2.2 2.2 0 0 1 4.4 0v1.7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
            />
          </svg>
          <span class="text-12 leading-18"
            ><b
              >Egress adds these headers to each request on the way to the server. The run never
              sees their values.</b
            >{{ ' '
            }}<span class="text-text-2"
              >Values stay in <code>.env</code>; see
              <RouterLink :to="secretsTab">Resources › Secrets</RouterLink>.</span
            ></span
          >
        </div>
      </div>
    </div>
  </McpFormRow>
</template>

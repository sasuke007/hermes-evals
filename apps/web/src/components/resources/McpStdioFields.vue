<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import BaseInput from '@/components/ui/BaseInput.vue';
import { ROUTE_NAMES } from '@/router';
import { useResourcesStore } from '@/stores/resources';
import ChipListInput from './ChipListInput.vue';
import McpFormRow from './McpFormRow.vue';

/**
 * The stdio rows of the MCP server form: the command and its arguments, and the environment
 * variable names, with the amber caution that the agent can read their values (MCP secrets
 * states) and, for a name the worker reports, whether it is set. Names only.
 */
withDefaults(defineProps<{ errors?: Partial<Record<string, string>>; idPrefix: string }>(), {
  errors: () => ({}),
});
const command = defineModel<string>('command', { required: true });
const args = defineModel<string>('args', { required: true });
const envNames = defineModel<string[]>('envNames', { required: true });

const store = useResourcesStore();
const envStatus = computed(() =>
  envNames.value.flatMap((name) => {
    const secret = store.secretFor(name, 'worker');
    return secret ? [{ name, set: secret.set }] : [];
  }),
);
const secretsTab = { name: ROUTE_NAMES.resourcesTab, params: { tab: 'secrets' } };
</script>

<template>
  <McpFormRow label="Command" help="Runs inside the run's container.">
    <div class="flex flex-wrap gap-12">
      <div class="w-200">
        <BaseInput v-model="command" label="Command" mono :error="errors.command" />
      </div>
      <div class="min-w-260 flex-1">
        <BaseInput v-model="args" label="Arguments" mono :error="errors.args" />
      </div>
    </div>
  </McpFormRow>
  <McpFormRow label="Environment variables" help="Names only.">
    <div class="flex max-w-640 flex-col gap-6">
      <ChipListInput
        v-model="envNames"
        label="Environment variable names"
        input-label="Add variable name"
        placeholder="Add name"
        :input-width="120"
        :transform="(t) => t.toUpperCase()"
        :invalid="!!errors.envNames"
        :described-by="errors.envNames ? `${idPrefix}-envNames-error` : null"
      />
      <p v-if="errors.envNames" :id="`${idPrefix}-envNames-error`" class="text-12 text-fail-text">
        {{ errors.envNames }}
      </p>
      <div
        class="flex items-start gap-8 rounded-4 border border-ung bg-ung-soft px-10 py-8"
        role="note"
        data-testid="stdio-caution"
      >
        <svg
          width="14"
          height="14"
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
        <span class="text-12 leading-18"
          ><b class="text-ung-text"
            >This server runs inside each run's container. The agent can read these values. Use
            scoped or throwaway values.</b
          >{{ ' '
          }}<span class="text-text-2"
            >Values stay in <code>.env</code> and are never typed, stored or shown here; see
            <RouterLink :to="secretsTab">Resources › Secrets</RouterLink> to check or set one.</span
          ><template v-for="env in envStatus" :key="env.name">
            {{ ' ' }}<span class="font-mono text-text">{{ env.name }}</span
            >{{ ' '
            }}<span :class="env.set ? 'text-pass-text' : 'font-semibold text-ung-text'">{{
              env.set ? 'is set' : 'is not set'
            }}</span
            >.</template
          ></span
        >
      </div>
    </div>
  </McpFormRow>
</template>

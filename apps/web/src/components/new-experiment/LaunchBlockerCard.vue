<script setup lang="ts">
import { RouterLink } from 'vue-router';
import CopyButton from '@/components/ui/CopyButton.vue';
import CopyCommand from '@/components/ui/CopyCommand.vue';
import { ROUTE_NAMES } from '@/router';
import type { LaunchBlocker } from './launchReadiness';

/**
 * One amber block in the summary panel saying why Launch is disabled, with its fix
 * (NewExperiment board; Components 2 › ExperimentSummaryPanel, blocked states): Connect Nous
 * Portal, which opens ConnectDialog; for an API-key provider the .env step with Copy and Open
 * System, never a Connect button; for the host proxy or a missing worker, the command to run.
 * Nothing entered is lost: the block clears by itself once the cause is fixed.
 *
 * Unset MCP variables (Phase 6 S7; drawn like the worker's block, no board has it): what to
 * set and the command that makes the worker or egress read it, then Check again, which reloads
 * the configurations, since nothing streams their variables, and a link to Secrets.
 */
defineProps<{ blocker: LaunchBlocker }>();
const emit = defineEmits<{ connect: []; recheck: [] }>();
const secretsTab = { name: ROUTE_NAMES.resourcesTab, params: { tab: 'secrets' } };
</script>

<template>
  <div
    role="status"
    class="flex flex-col gap-8 rounded-4 border border-ung bg-ung-soft px-12 py-10"
    :data-fix="blocker.fix"
    data-testid="launch-blocker"
  >
    <b class="text-ung-text">{{ blocker.reason }}</b>

    <template v-if="blocker.fix === 'connect' || blocker.fix === 'reconnect'">
      <button type="button" class="btn primary h-28 self-start text-12" @click="emit('connect')">
        {{ blocker.fix === 'connect' ? 'Connect Nous Portal' : 'Reconnect Nous Portal' }}
      </button>
    </template>

    <template v-else-if="blocker.fix === 'add-key'">
      <span class="text-12 leading-18 text-text-2">
        <template v-for="(name, i) in blocker.configurations" :key="name"
          ><code>{{ name }}</code
          >{{ i < blocker.configurations.length - 1 ? ', ' : '' }}</template
        >
        {{ blocker.configurations.length === 1 ? 'uses' : 'use' }}
        <code>{{ blocker.provider }}</code
        >. The platform never accepts keys in the UI.
      </span>
      <div class="flex items-start gap-8 rounded-4 border border-border bg-surface px-10 py-8">
        <span class="flex-1 text-12 leading-18"
          >Add <code>{{ blocker.envVar ?? 'the API key' }}=…</code> to <code>.env</code>, then run
          <code>{{ blocker.command }}</code></span
        >
        <CopyButton :text="blocker.command ?? ''" variant="button" label="Copy the command" />
      </div>
      <RouterLink :to="{ name: ROUTE_NAMES.system }" class="text-12">Open System</RouterLink>
    </template>

    <template v-else-if="blocker.fix === 'secrets'">
      <span class="text-12 leading-18 text-text-2">{{ blocker.detail }}</span>
      <CopyCommand v-if="blocker.command" :command="blocker.command" />
      <div class="flex flex-wrap items-center gap-12">
        <button
          type="button"
          class="btn h-28 text-12"
          data-testid="recheck-secrets"
          @click="emit('recheck')"
        >
          Check again
        </button>
        <RouterLink :to="secretsTab" class="text-12">Open Secrets</RouterLink>
      </div>
    </template>

    <template v-else>
      <span v-if="blocker.detail" class="text-12 leading-18 text-text-2">{{ blocker.detail }}</span>
      <CopyCommand v-if="blocker.command" :command="blocker.command" />
      <RouterLink :to="{ name: ROUTE_NAMES.system }" class="text-12">Open System</RouterLink>
    </template>
  </div>
</template>

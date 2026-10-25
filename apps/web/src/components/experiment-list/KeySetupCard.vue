<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { ProviderInfo } from '@/api/types/system';
import CopyButton from '@/components/ui/CopyButton.vue';
import { ROUTE_NAMES } from '@/router';

/**
 * Above the experiment list when the only provider the configurations use is an API-key
 * provider with no key on the server (ExperimentList tweak "openrouter key missing"). There is
 * no Connect button: a key is only ever added on the server, so the card gives the .env step
 * with Copy and a link to System. The AppShell shows the no-key banner at the same time.
 */
const props = defineProps<{ provider: ProviderInfo }>();

const DEFAULT_APPLY = 'docker compose up -d egress worker';

/** "Add an OpenRouter API key", "Add a Nous API key". */
const title = computed(() => {
  const name = props.provider.name;
  const key = /\bAPI$/.test(name) ? `${name} key` : `${name} API key`;
  return `Add ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${key} to run experiments`;
});
const envVar = computed(() => props.provider.envVar ?? 'the API key');
const apply = computed(() => props.provider.applyCommand ?? DEFAULT_APPLY);
</script>

<template>
  <section
    class="flex flex-col gap-10 rounded-6 border border-border-strong bg-surface px-18 py-16"
    aria-labelledby="key-setup-title"
    data-testid="key-setup-card"
  >
    <div class="flex flex-wrap items-start justify-between gap-x-24 gap-y-8">
      <div class="flex max-w-720 flex-col gap-4">
        <b id="key-setup-title" class="text-15">{{ title }}</b>
        <span class="text-text-2"
          >Your configurations use <code>{{ provider.id }}</code
          >, and the server has no key for it. The platform never accepts keys in the UI: add it on
          the server.</span
        >
      </div>
      <RouterLink :to="{ name: ROUTE_NAMES.system }" class="text-12">Open System</RouterLink>
    </div>
    <div
      class="flex flex-wrap items-center gap-8 rounded-4 border border-border bg-surface-2 px-10 py-8"
    >
      <span class="min-w-240 flex-1 text-12 leading-18"
        >Add <code>{{ envVar }}=…</code> to <code>.env</code>, then run
        <code>{{ apply }}</code></span
      >
      <CopyButton :text="apply" variant="button" label="Copy the command" />
    </div>
  </section>
</template>

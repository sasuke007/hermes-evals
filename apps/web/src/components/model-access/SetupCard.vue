<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import CopyButton from '@/components/ui/CopyButton.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import { useProvidersStore } from '@/stores/providers';

/**
 * Shown above the experiment list when no model can be reached. The list below stays usable.
 * Not dismissible: it goes away when a provider connects (`show` overrides that).
 *
 *   auto (default)  whichever of the two cards below applies (providers.setupVariant)
 *   card            no provider is connected at all: Connect Nous Portal · Use an API key instead
 *   missing-key     every provider the configurations use is an API-key provider without a key
 *                   (ExperimentList board): no Connect button, the server step with Copy, and
 *                   Open System, because keys are never accepted in the UI
 *   empty           the card merged into the empty experiment list (the first step of Flow A):
 *                   once connected, step 1 shows a Connected chip and the primary action becomes
 *                   New configuration
 */
const props = withDefaults(
  defineProps<{
    variant?: 'auto' | 'card' | 'missing-key' | 'empty';
    title?: string;
    body?: string;
    /** card, missing-key: null follows the store. */
    show?: boolean | null;
    /** "Use an API key instead", "Open System" → System › Model access. */
    systemTo?: RouteLocationRaw;
    /** variant="empty", connected: where New configuration goes. */
    newConfigurationTo?: RouteLocationRaw;
  }>(),
  {
    variant: 'auto',
    title: 'Connect a model to run experiments',
    body: 'Experiments call a model. Connect Nous Portal once, or add an API key for another provider.',
    show: null,
    systemTo: '/system',
    newConfigurationTo: '/configurations/new',
  },
);
const emit = defineEmits<{ connect: [] }>();
const providers = useProvidersStore();

/** The card drawn: `auto` resolves to the one the store asks for. */
const kind = computed<'card' | 'missing-key' | 'empty' | null>(() => {
  if (props.variant === 'empty') return 'empty';
  const wanted = providers.setupVariant;
  if (props.variant === 'auto') {
    if (props.show === false) return null;
    if (wanted === 'missing-key') return 'missing-key';
    return wanted === 'connect' || props.show === true ? 'card' : null;
  }
  const visible =
    props.show ?? (props.variant === 'card' ? wanted === 'connect' : wanted === 'missing-key');
  return visible ? props.variant : null;
});
const connected = computed(() => providers.anyConnected);

/** The provider the missing-key card names; OpenRouter's wording when none is known yet. */
const keyProvider = computed(() => {
  const p = providers.setupKeyProvider ?? providers.missingKeyProvider;
  return {
    id: p?.id ?? 'openrouter',
    name: p?.name ?? 'OpenRouter',
    envVar: p?.envVar ?? 'OPENROUTER_API_KEY',
    applyCommand: p?.applyCommand ?? 'docker compose up -d egress worker',
  };
});
/** "Add an OpenRouter API key to run experiments" ("a Nous API key" for Nous API). */
const keyTitle = computed(() => {
  const name = keyProvider.value.name;
  const phrase = /\bAPI$/.test(name) ? `${name} key` : `${name} API key`;
  return `Add ${/^[aeiou]/i.test(phrase) ? 'an' : 'a'} ${phrase} to run experiments`;
});

function connect(): void {
  emit('connect');
  void providers.connect('other');
}
</script>

<template>
  <section
    v-if="kind === 'card'"
    class="flex flex-wrap items-center justify-between gap-x-24 gap-y-12 rounded-6 border border-border-strong bg-surface px-18 py-16"
    aria-labelledby="setup-card-title"
    data-testid="setup-card"
  >
    <div class="flex max-w-620 flex-col gap-4">
      <b id="setup-card-title" class="text-15">{{ title }}</b>
      <span class="text-text-2">{{ body }}</span>
    </div>
    <div class="flex items-center gap-12">
      <button type="button" class="btn primary" @click="connect">Connect Nous Portal</button>
      <RouterLink :to="systemTo" class="text-12">Use an API key instead</RouterLink>
    </div>
  </section>
  <section
    v-else-if="kind === 'missing-key'"
    class="flex flex-col gap-10 rounded-6 border border-border-strong bg-surface px-18 py-16"
    aria-labelledby="setup-key-title"
    data-testid="setup-key-card"
    :data-provider="keyProvider.id"
  >
    <div class="flex flex-wrap items-start justify-between gap-x-24 gap-y-8">
      <div class="flex max-w-720 flex-col gap-4">
        <b id="setup-key-title" class="text-15">{{ keyTitle }}</b>
        <span class="text-text-2"
          >Your configurations use <code>{{ keyProvider.id }}</code
          >, and the server has no key for it. The platform never accepts keys in the UI: add it on
          the server.</span
        >
      </div>
      <RouterLink :to="systemTo" class="text-12">Open System</RouterLink>
    </div>
    <div
      class="flex flex-wrap items-center gap-8 rounded-4 border border-border bg-surface-2 px-10 py-8"
    >
      <span class="min-w-240 flex-1 text-12 leading-18"
        >Add <code>{{ keyProvider.envVar }}=…</code> to <code>.env</code>, then run
        <code>{{ keyProvider.applyCommand }}</code></span
      >
      <CopyButton
        class="h-26"
        variant="button"
        :text="keyProvider.applyCommand"
        label="Copy the command"
        button-text="Copy"
      />
    </div>
  </section>
  <div
    v-else-if="kind === 'empty'"
    class="flex flex-col items-start gap-10 rounded-6 border border-border bg-surface px-28 py-36"
    data-testid="setup-empty"
  >
    <div class="text-17 font-semibold">No experiments yet</div>
    <p class="max-w-520 text-text-2">
      An experiment runs every task in a suite under two or more configurations, several times each,
      and tells you which configuration did better.
    </p>
    <ol class="mt-4 flex list-decimal flex-col gap-4 pl-18 text-text-2">
      <li>
        <b class="text-text">Connect a model.</b> Experiments call one.
        <StatusChip v-if="connected" kind="provider" status="connected" size="sm"
          >Connected</StatusChip
        >
        <span v-else class="text-ung-text">Not connected yet.</span>
      </li>
      <li>Create two configurations that differ in one thing.</li>
      <li>Start an experiment on a suite.</li>
    </ol>
    <div class="mt-6 flex items-center gap-10">
      <RouterLink v-if="connected" :to="newConfigurationTo" class="btn primary"
        >New configuration</RouterLink
      >
      <template v-else>
        <button type="button" class="btn primary" @click="connect">Connect Nous Portal</button>
        <RouterLink :to="systemTo" class="text-12">Use an API key instead</RouterLink>
      </template>
    </div>
  </div>
</template>

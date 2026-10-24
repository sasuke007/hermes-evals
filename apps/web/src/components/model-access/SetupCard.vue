<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import StatusChip from '@/components/ui/StatusChip.vue';
import { useProvidersStore } from '@/stores/providers';

/**
 * Shown above the experiment list when no provider is connected at all. The list below stays
 * usable. Not dismissible: it goes away when a provider connects (`show` overrides that).
 * variant="empty" is the card merged into the empty experiment list (the first step of Flow A):
 * once connected, step 1 shows a Connected chip and the primary action becomes New
 * configuration.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'card' | 'empty';
    title?: string;
    body?: string;
    /** card: null follows the store (shown while no provider is connected). */
    show?: boolean | null;
    /** "Use an API key instead" → System › Model access. */
    systemTo?: RouteLocationRaw;
    /** variant="empty", connected: where New configuration goes. */
    newConfigurationTo?: RouteLocationRaw;
  }>(),
  {
    variant: 'card',
    title: 'Connect a model to run experiments',
    body: 'Experiments call a model. Connect Nous Portal once, or add an API key for another provider.',
    show: null,
    systemTo: '/system',
    newConfigurationTo: '/configurations/new',
  },
);
const emit = defineEmits<{ connect: [] }>();
const providers = useProvidersStore();

const visible = computed(() => props.show ?? (providers.loaded && !providers.anyConnected));
const connected = computed(() => providers.anyConnected);

function connect(): void {
  emit('connect');
  void providers.connect('other');
}
</script>

<template>
  <section
    v-if="variant === 'card' && visible"
    class="panel setup-card"
    aria-labelledby="setup-card-title"
  >
    <div class="sc-text">
      <b id="setup-card-title" class="sc-title">{{ title }}</b>
      <span class="t2">{{ body }}</span>
    </div>
    <div class="sc-actions">
      <button type="button" class="btn primary lg" @click="connect">Connect Nous Portal</button>
      <RouterLink :to="systemTo" class="sc-link">Use an API key instead</RouterLink>
    </div>
  </section>
  <div v-else-if="variant === 'empty'" class="panel setup-empty">
    <div class="se-title">No experiments yet</div>
    <p class="t2 se-body">
      An experiment runs every task in a suite under two or more configurations, several times each,
      and tells you which configuration did better.
    </p>
    <ol class="t2 se-steps">
      <li>
        <b class="se-strong">Connect a model.</b> Experiments call one.
        <StatusChip v-if="connected" kind="provider" status="connected" size="sm"
          >Connected</StatusChip
        >
        <span v-else class="se-warn">Not connected yet.</span>
      </li>
      <li>Create two configurations that differ in one thing.</li>
      <li>Start an experiment on a suite.</li>
    </ol>
    <div class="sc-actions se-actions">
      <RouterLink v-if="connected" :to="newConfigurationTo" class="btn primary"
        >New configuration</RouterLink
      >
      <template v-else>
        <button type="button" class="btn primary" @click="connect">Connect Nous Portal</button>
        <RouterLink :to="systemTo" class="sc-link">Use an API key instead</RouterLink>
      </template>
    </div>
  </div>
</template>

<style scoped>
.setup-card {
  padding: 16px 18px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  align-items: center;
  justify-content: space-between;
  border-color: var(--border-strong);
}
.sc-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 560px;
}
.sc-title {
  font-size: 15px;
  line-height: 22px;
}
.sc-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.sc-link {
  font-size: 12px;
}
.setup-empty {
  padding: 36px 28px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.se-title {
  font-weight: 600;
  font-size: 17px;
  line-height: 24px;
}
.se-body {
  max-width: 520px;
}
.se-steps {
  margin: 4px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.se-strong {
  color: var(--text);
}
.se-warn {
  color: var(--ung-text);
}
.se-actions {
  margin-top: 6px;
}
</style>

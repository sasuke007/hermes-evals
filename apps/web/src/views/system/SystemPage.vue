<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { errorMessage } from '@/api/client';
import { listSecrets } from '@/api/resources';
import { getSystemSetup } from '@/api/system';
import type { SecretRow } from '@/api/types/resources';
import type { SystemSetup } from '@/api/types/system';
import PageContainer from '@/components/layout/PageContainer.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import { usePolling } from '@/composables/usePolling';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import ModelAccessSection from './ModelAccessSection.vue';
import SandboxSection from './SandboxSection.vue';
import SecretsSection from './SecretsSection.vue';
import SetupSection from './SetupSection.vue';
import WorkersSection from './WorkersSection.vue';

/**
 * System (plan 12.2 items 1 and 11; System and SystemDark boards): Model access with the Nous
 * connect flow, the LLM judge and the samples seed (Phase 8), the secrets MCP servers
 * reference, the sandbox's isolation proof and the workers. Read live from the running stack:
 * the summary stream (the AppShell keeps it open) carries the workers, and this page reads
 * providers every 5 s, so a terminal login or a restarted host proxy shows without a reload,
 * secrets every 30 s, and the setup every 2 s while the seed runs (it changes at no other
 * time). It never shows or stores a token or a key.
 */
const PROVIDERS_REFRESH_MS = 5_000;
const SECRETS_REFRESH_MS = 30_000;
const SEED_REFRESH_MS = 2_000;

const providers = useProvidersStore();
const system = useSystemStore();

const secrets = ref<SecretRow[] | null>(null);
const secretsError = ref<string | null>(null);

async function loadSecrets(): Promise<void> {
  try {
    secrets.value = await listSecrets();
    secretsError.value = null;
  } catch (err) {
    secretsError.value = errorMessage(err);
  }
}

const setup = ref<SystemSetup | null>(null);
const setupError = ref<string | null>(null);

async function loadSetup(): Promise<void> {
  try {
    setup.value = await getSystemSetup();
    setupError.value = null;
  } catch (err) {
    setupError.value = errorMessage(err);
  }
}

usePolling(() => providers.load(), PROVIDERS_REFRESH_MS);
usePolling(loadSecrets, SECRETS_REFRESH_MS);
usePolling(loadSetup, SEED_REFRESH_MS, () => setup.value?.seed.state === 'running');

onMounted(() => {
  void providers.load();
  void system.load();
  void loadSecrets();
  void loadSetup();
});
</script>

<template>
  <PageContainer variant="system">
    <PageHeader
      title="System"
      description="Model access, the judge and the samples, the run sandbox and the workers. Read live from the running stack. This page never shows or stores a token or a key."
    />
    <ModelAccessSection />
    <SetupSection :setup="setup" :error="setupError" @retry="loadSetup" />
    <SecretsSection :secrets="secrets" :error="secretsError" @retry="loadSecrets" />
    <SandboxSection />
    <WorkersSection />
  </PageContainer>
</template>

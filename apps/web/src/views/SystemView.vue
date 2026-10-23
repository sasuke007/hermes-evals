<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { HealthResponse } from '@hermes-evals/shared';
import { getHealth } from '@/api/system';

const health = ref<HealthResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    health.value = await getHealth();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const tone = (v: string): string => (v === 'ok' ? 'pass' : v === 'unavailable' ? 'fail' : 'que');
</script>

<template>
  <main class="page">
    <div class="head">
      <h1 class="page-title">System</h1>
      <button type="button" class="btn" :disabled="loading" @click="load">Refresh</button>
    </div>
    <div v-if="error" role="alert" class="panel alert">
      <b>Could not reach the API</b>
      <code>{{ error }}</code>
      <span class="cap"
        >Check that the <code>api</code> service is up: <code>pnpm dev</code> or
        <code>docker compose ps api</code></span
      >
    </div>
    <dl v-else-if="health" class="panel grid" data-testid="health">
      <dt>Status</dt>
      <dd>
        <span class="chip" :class="`tone-${tone(health.status)}`">{{ health.status }}</span>
      </dd>
      <dt>Version</dt>
      <dd class="mono">{{ health.version }}</dd>
      <dt>Uptime</dt>
      <dd class="mono">{{ health.uptimeSeconds }} s</dd>
      <dt>Database</dt>
      <dd>
        <span class="chip" :class="`tone-${tone(health.checks.database)}`">{{
          health.checks.database
        }}</span>
      </dd>
      <dt>Migrations</dt>
      <dd>
        <span class="chip" :class="`tone-${tone(health.checks.migrations)}`">{{
          health.checks.migrations
        }}</span>
      </dd>
      <dt>Queue</dt>
      <dd>
        <span class="chip" :class="`tone-${tone(health.checks.queue)}`">{{
          health.checks.queue
        }}</span>
      </dd>
      <dt>Checked</dt>
      <dd class="mono t2">{{ health.timestamp }}</dd>
    </dl>
    <p v-else class="cap">Loading…</p>
  </main>
</template>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.grid {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 0;
  margin: 0;
  max-width: 640px;
}
.grid dt,
.grid dd {
  margin: 0;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.grid dt {
  color: var(--text-2);
}
.grid dt:nth-last-of-type(1),
.grid dd:last-child {
  border-bottom: 0;
}
.alert {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border-color: var(--fail);
  background: var(--fail-soft);
  max-width: 640px;
}
.tone-pass {
  background: var(--pass-soft);
  color: var(--pass-text);
}
.tone-fail {
  background: var(--fail-soft);
  color: var(--fail-text);
}
.tone-que {
  background: var(--que-soft);
  color: var(--que-text);
}
</style>
